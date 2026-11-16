import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { answerQuestion, explainOne, locateEvidence, parseStack, suggestPrompts } from '../src/assistant/index.js';
import type { ChatContext } from '../src/ai/prompts.js';

const STACK = 'TypeError: Cannot read properties of undefined (reading \'name\')\n    at renderUser (https://shop.example/static/app.js:128:19)\n    at https://shop.example/static/app.js:240:3';

const exception = {
  code: 'NBA-000012', severity: 'high', confidence: 'confirmed', category: 'console', title: 'Unhandled JavaScript exception',
  description: "Cannot read properties of undefined (reading 'name')", affectedUrl: 'https://shop.example/',
  suggestedFix: 'Guard against undefined values.',
  evidence: { message: "Cannot read properties of undefined (reading 'name')", stack: STACK },
  checkKey: 'exception_0_abc',
};
const notFound = {
  code: 'NBA-000013', severity: 'medium', confidence: 'confirmed', category: 'console', title: 'image request returned HTTP 404',
  description: 'https://shop.example/img/hero.png answered HTTP 404.', affectedUrl: 'https://shop.example/img/hero.png',
  suggestedFix: 'Fix the path.', evidence: { url: 'https://shop.example/img/hero.png', status: 404, resourceType: 'image' }, checkKey: 'http_error_404_x',
};
const noSource = {
  code: 'NBA-000014', severity: 'medium', confidence: 'confirmed', category: 'console', title: 'Console error',
  description: 'Something failed', affectedUrl: 'https://shop.example/', suggestedFix: 'x', evidence: { text: 'Something failed' }, checkKey: 'console_error_1_zz',
};
const header = { code: 'NBA-000015', severity: 'low', confidence: 'confirmed', category: 'security', title: 'Missing Content-Security-Policy header', description: 'No CSP.', affectedUrl: 'https://shop.example/', suggestedFix: 'Add CSP', evidence: {}, checkKey: 'csp' };

const ctx = (over: Partial<ChatContext> = {}): ChatContext => ({
  hostname: 'shop.example', targetUrl: 'https://shop.example/', status: 'completed', overall: 'issues', incomplete: false, finishedAt: null,
  counts: { fail: 3, pass: 20 }, modules: [{ id: 'console', label: 'console', status: 'completed', note: null }, { id: 'pwa', label: 'pwa', status: 'skipped', note: 'not applicable' }],
  issues: [header, noSource, notFound, exception], issuesOmitted: 0, recentLogs: [], previous: null, ...over,
});

describe('locating problems in evidence', () => {
  it('parses file, line, column and function from a stack trace', () => {
    const [a, b] = parseStack(STACK);
    assert.equal(a!.file, 'app.js'); assert.equal(a!.line, 128); assert.equal(a!.column, 19); assert.equal(a!.func, 'renderUser');
    assert.equal(b!.line, 240);
  });
  it('uses console source and line, and failed script requests', () => {
    const l = locateEvidence({ source: 'https://x.test/a/main.js', line: 7, column: 2 });
    assert.equal(l.locations[0]!.file, 'main.js'); assert.equal(l.locations[0]!.line, 7);
    assert.equal(locateEvidence({ url: 'https://x.test/lib.js', resourceType: 'script', status: 404 }).locations[0]!.file, 'lib.js');
  });
  it('collects element selectors and finds nothing when there is nothing', () => {
    const l = locateEvidence({ elements: [{ selector: 'button.buy', html: '<button class="buy"></button>' }] });
    assert.equal(l.elements[0]!.selector, 'button.buy');
    const none = locateEvidence({});
    assert.deepEqual([none.locations.length, none.elements.length], [0, 0]);
  });
});

describe('explaining an issue', () => {
  it('names the file, line and function, the cause, the fix and what to change', () => {
    const t = explainOne(exception);
    assert.match(t, /app\.js:128:19/); assert.match(t, /renderUser/);
    assert.match(t, /\*\*What happened\*\*/); assert.match(t, /\*\*Why it happens\*\*/); assert.match(t, /\*\*How to fix\*\*/); assert.match(t, /\*\*What to change\*\*/);
    assert.match(t, /optional chaining|\?\./); assert.match(t, /In app\.js:128:19/);
  });
  it('never invents a line number when none was recorded', () => {
    const t = explainOne(noSource);
    assert.doesNotMatch(t, /\.js:\d+/);
    assert.match(t, /not captured|did not report/i);
  });
  it('explains a 404 with the URL and a redirect example', () => {
    const t = explainOne(notFound);
    assert.match(t, /hero\.png/); assert.match(t, /301/);
  });
  it('gives header guidance with a code example', () => {
    assert.match(explainOne(header), /Content-Security-Policy/);
  });
});

describe('answering questions', () => {
  it('explains the issue named by its code', () => {
    assert.match(answerQuestion('Please explain NBA-000012', ctx()), /app\.js:128:19/);
  });
  it('says so when the code does not exist', () => {
    assert.match(answerQuestion('explain NBA-999999', ctx()), /can’t find NBA-999999/);
  });
  it('ranks by severity for "what should I fix first"', () => {
    const t = answerQuestion('What should I fix first?', ctx());
    assert.ok(t.indexOf('NBA-000012') < t.indexOf('NBA-000015'));
  });
  it('answers "which file and line" using only recorded locations', () => {
    const t = answerQuestion('Which file and line caused the errors?', ctx());
    assert.match(t, /app\.js:128:19/); assert.match(t, /no file, line or element was recorded/);
  });
  it('matches an issue from free text', () => {
    assert.match(answerQuestion('why is my hero image returning 404', ctx()), /hero\.png/);
  });
  it('reports skipped modules honestly and never says bug-free', () => {
    const t = answerQuestion('what was tested?', ctx());
    assert.match(t, /pwa.*skipped/s);
    const clean = answerQuestion('summarise', ctx({ issues: [], counts: { pass: 30 } }));
    assert.match(clean, /No issues detected in the tests performed/); assert.doesNotMatch(clean, /bug-free|no bugs/i);
  });
  it('is honest while a test is still running', () => {
    assert.match(answerQuestion('what is wrong?', ctx({ status: 'running', issues: [] })), /running/);
  });
  it('answers general questions without a report, and says it has no data', () => {
    assert.match(answerQuestion('what is a CORS error', null), /Access-Control-Allow-Origin/);
    assert.match(answerQuestion('explain my errors', null), /No test report is attached/);
  });
  it('suggests prompts from the real report', () => {
    const p = suggestPrompts(ctx());
    assert.match(p[0]!, /NBA-000012/); assert.ok(p.some((x) => /file and line/i.test(x)));
  });
});
