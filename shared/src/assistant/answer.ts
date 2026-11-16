import type { ChatContext } from '../ai/prompts.js';
import { explainIssue, TOPICS, type AssistantIssue } from './knowledge.js';
import { describeLocation, locateEvidence, type Located } from './locate.js';

/**
 * BUGSY's built-in debugging assistant. It answers from the stored test results only: every URL, file, line,
 * element and message comes from recorded evidence. When the evidence does not hold something (for example a
 * source line), the answer says so instead of guessing. It needs no AI service, so chat always works; when an AI
 * provider is configured it adds conversational depth on top of the same evidence.
 */

type Issue = ChatContext['issues'][number] & { checkKey?: string | null; moduleId?: string | null };

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
const SEV_LABEL: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', informational: 'Info' };
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function toAssistantIssue(i: Issue): AssistantIssue {
  return { code: i.code, severity: i.severity, confidence: i.confidence, category: i.category, title: i.title, description: i.description, affectedUrl: i.affectedUrl, suggestedFix: i.suggestedFix, evidence: i.evidence ?? {}, checkKey: i.checkKey ?? null, moduleId: i.moduleId ?? null, ai: i.ai };
}

/** One issue explained end to end: what, where, why, how to fix, what to change, how to verify. */
export function explainOne(issue: Issue): string {
  const a = toAssistantIssue(issue);
  const loc: Located = locateEvidence(a.evidence, a.affectedUrl);
  const ex = explainIssue(a, loc);
  const out: string[] = [];

  out.push(`**${a.code} · ${SEV_LABEL[a.severity] ?? a.severity} · ${cap(a.title, 90)}** (${a.confidence})`);

  const message = (typeof a.evidence.message === 'string' && a.evidence.message) || (typeof a.evidence.text === 'string' && a.evidence.text) || a.description;
  out.push(`**What happened**\n${cap(message, 400)}`);

  const whereLines: string[] = [];
  if (a.affectedUrl) whereLines.push(`- Page or URL: ${a.affectedUrl}`);
  if (loc.locations.length) {
    for (const l of loc.locations.slice(0, 3)) whereLines.push(`- File and line: \`${describeLocation(l)}\` (from the ${l.from})${l.func ? `, in function \`${l.func}\`` : ''}${l.url ? ` — ${l.url}` : ''}`);
  } else if (/exception|console|click_error/i.test(`${a.checkKey ?? ''} ${a.title}`)) {
    whereLines.push('- File and line: not captured for this error (the browser did not report a source). Open DevTools → Console on the page and expand the error to see the stack trace.');
  }
  for (const e of loc.elements.slice(0, 3)) whereLines.push(`- Element: \`${cap(e.selector, 120)}\`${e.html ? ` — \`${cap(e.html, 120)}\`` : ''}`);
  const others = loc.urls.filter((u) => u !== a.affectedUrl).slice(0, 4);
  if (others.length) whereLines.push(`- Related URLs: ${others.join(', ')}`);
  if (whereLines.length) out.push(`**Where**\n${whereLines.join('\n')}`);

  out.push(`**Why it happens**\n${ex.cause}`);
  if (ex.steps.length) out.push(`**How to fix**\n${ex.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
  if (ex.change) out.push(`**What to change**\n${ex.change}`);
  if (ex.example) out.push('```' + ex.example.lang + '\n' + ex.example.code + '\n```');
  if (a.ai?.explanation) out.push(`**AI analysis** (not test evidence)\n${cap(a.ai.explanation, 500)}`);
  out.push(`**How to verify**\n${ex.verify ?? 'Fix the cause, then run the test again. The issue should no longer be reported.'}`);
  return out.join('\n\n');
}

function summary(ctx: ChatContext): string {
  const total = ctx.issues.length + ctx.issuesOmitted;
  const bySev: Record<string, number> = {};
  for (const i of ctx.issues) bySev[i.severity] = (bySev[i.severity] ?? 0) + 1;
  const sevText = ['critical', 'high', 'medium', 'low', 'informational'].filter((s) => bySev[s]).map((s) => `${bySev[s]} ${s}`).join(', ');
  const skipped = ctx.modules.filter((m) => m.status === 'skipped' || m.status === 'blocked' || m.status === 'failed');
  const lines = [`**Summary for ${ctx.hostname}**`];
  if (ctx.status !== 'completed') lines.push(`The test is **${ctx.status}**. Results below are partial.`);
  lines.push(total === 0 ? 'No issues detected in the tests performed.' : `${plural(total, 'issue')} found${sevText ? ` (${sevText})` : ''}.`);
  const c = ctx.counts;
  const done = Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ');
  if (done) lines.push(`Checks recorded: ${done}.`);
  if (skipped.length) lines.push(`Not fully tested: ${skipped.map((m) => `${m.id} (${m.status}${m.note ? `: ${cap(m.note, 80)}` : ''})`).join('; ')}.`);
  if (ctx.incomplete) lines.push('The run is marked **incomplete**, so "no issues" only applies to the tests that ran.');
  return lines.join('\n\n');
}

function priorities(ctx: ChatContext): string {
  if (ctx.issues.length === 0) return 'There is nothing to fix from this report: no issues were detected in the tests performed.';
  const ranked = [...ctx.issues].sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) || (a.confidence === 'confirmed' ? 0 : 1) - (b.confidence === 'confirmed' ? 0 : 1));
  const top = ranked.slice(0, 5);
  const lines = top.map((i, n) => `${n + 1}. **${i.code}** (${SEV_LABEL[i.severity] ?? i.severity}, ${i.confidence}) — ${cap(i.title, 90)}${i.affectedUrl ? ` on ${cap(i.affectedUrl, 70)}` : ''}`);
  return `**Fix in this order**\n\n${lines.join('\n')}\n\nCritical and high issues that are confirmed come first, because they affect real visitors or security. Ask me to explain any code, for example “Explain ${top[0]!.code}”.`;
}

function tested(ctx: ChatContext): string {
  const lines = ctx.modules.map((m) => `- **${m.id}**: ${m.status}${m.note ? ` — ${cap(m.note, 110)}` : ''}`);
  const notRun = ctx.modules.filter((m) => !['completed'].includes(m.status));
  return `**What was tested**\n\n${lines.join('\n')}${notRun.length ? `\n\n${plural(notRun.length, 'module')} did not complete normally. Skipped or blocked checks are never counted as passed.` : ''}`;
}

function changes(ctx: ChatContext): string {
  const p = ctx.previous;
  if (!p) return 'There is no earlier completed test of this site to compare with. Run another test after your fixes and I can show what changed.';
  const lines = [`**Since your previous test${p.finishedAt ? ` (${p.finishedAt.slice(0, 10)})` : ''}**`, `- Fixed: ${p.fixed.length ? p.fixed.slice(0, 6).map((t) => cap(t, 70)).join('; ') : 'none'}`, `- New: ${p.newIssues.length ? p.newIssues.slice(0, 6).map((t) => cap(t, 70)).join('; ') : 'none'}`, `- Still open: ${p.remaining}`];
  return lines.join('\n');
}

function score(words: string[], i: Issue): number {
  const hay = `${i.code} ${i.title} ${i.category} ${i.description} ${i.checkKey ?? ''} ${i.affectedUrl ?? ''} ${JSON.stringify(i.evidence ?? {}).slice(0, 600)}`.toLowerCase();
  return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
}

const STOP = new Set('the a an is are was were be to of in on at for and or why how what which where does do did my this that it with from can could should would please tell me about error issue problem bug fix explain show'.split(' '));

export function answerQuestion(question: string, ctx: ChatContext | null): string {
  const q = question.trim();
  const lower = q.toLowerCase();

  if (/^(hi|hello|hey|yo|good (morning|afternoon|evening))\b/.test(lower) && lower.length < 30) {
    return ctx ? `Hi! I can explain any issue from your test of **${ctx.hostname}**: what failed, where, why, and how to fix it. Try “What should I fix first?” or ask about an issue code.` : 'Hi! Open one of your reports and I can explain its issues in detail: what failed, where, why, and how to fix it.';
  }
  if (/^(thanks|thank you|thx|great|perfect|ok(ay)?)[.! ]*$/.test(lower)) return 'You’re welcome! Run the test again after your fixes and I’ll help you check what changed.';

  if (!ctx) {
    const topic = TOPICS.find((t) => t.test.test(q));
    if (topic) return `**${topic.title}**\n\n${topic.body}\n\nOpen one of your test reports and I can show exactly where this appears on your site.`;
    return 'No test report is attached to this chat, so I have no results to explain. Open a report and ask me about it, or ask a general question such as “what is a CORS error?” or “how do I fix a 404?”.';
  }

  // A test that is still running has no findings yet: say what is happening, honestly.
  if (ctx.status === 'queued' || ctx.status === 'running') {
    const done = ctx.modules.filter((m) => ['completed', 'failed', 'skipped', 'blocked'].includes(m.status)).length;
    const running = ctx.modules.filter((m) => m.status === 'running').map((m) => m.id);
    return `The test of **${ctx.hostname}** is **${ctx.status}**: ${done} of ${ctx.modules.length} test modules have finished${running.length ? `, now running: ${running.join(', ')}` : ''}. ${ctx.issues.length ? `${plural(ctx.issues.length, 'issue')} found so far.` : 'No issues found so far.'} Ask me again when it completes for a full explanation.`;
  }

  const codes = [...q.matchAll(/NBA-\d{3,8}/gi)].map((m) => m[0]!.toUpperCase());
  const byCode = codes.map((c) => ctx.issues.find((i) => i.code.toUpperCase() === c)).filter(Boolean) as Issue[];
  if (codes.length && byCode.length === 0) return `I can’t find ${codes.join(', ')} in this report. ${ctx.issues.length ? `The issues I can see are: ${ctx.issues.slice(0, 8).map((i) => i.code).join(', ')}.` : 'This report has no issues.'}`;
  if (byCode.length) return byCode.slice(0, 2).map(explainOne).join('\n\n---\n\n');

  if (/what changed|since (my )?last|previous (test|run)|compare|fixed since/.test(lower)) return changes(ctx);
  if (/fix first|priorit|most important|where (do|should) i start|what should i (fix|do)|order/.test(lower)) return priorities(ctx);
  if (/what (was|were|did you|have you) (not )?test|not tested|skipped|coverage|which (tests|checks)|modules/.test(lower)) return tested(ctx);
  if (/summar|overview|overall|how (did|is) (it|my site)|results?\b.*\b(look|so far)|what did you find|what was found/.test(lower) && !/line|file/.test(lower)) return summary(ctx);

  if (ctx.issues.length === 0) return `${summary(ctx)}\n\nThere are no issues to explain. ${tested(ctx)}`;

  // Find the issue(s) the question is about by category words, then by words in the issue itself.
  const words = lower.replace(/[^a-z0-9_./:-]+/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w));
  const wantsWhere = /\b(line|file|where|which page|location|source|stack)\b/.test(lower);
  const catHit = ctx.issues.filter((i) => words.includes(i.category.toLowerCase()) || words.some((w) => w.length > 3 && i.category.toLowerCase().startsWith(w)));
  const scored = ctx.issues.map((i) => ({ i, s: score(words, i) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || (SEV_RANK[a.i.severity] ?? 9) - (SEV_RANK[b.i.severity] ?? 9));

  let picks: Issue[] = [];
  if (scored.length && scored[0]!.s >= 2) picks = scored.filter((x) => x.s === scored[0]!.s).map((x) => x.i);
  else if (catHit.length) picks = catHit;
  else if (scored.length) picks = scored.map((x) => x.i);
  else picks = [...ctx.issues].sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9));

  if (wantsWhere) {
    const rows = picks.slice(0, 6).map((i) => {
      const loc = locateEvidence(i.evidence, i.affectedUrl);
      const parts = [i.affectedUrl ? `page ${i.affectedUrl}` : null, loc.locations[0] ? `\`${describeLocation(loc.locations[0])}\`` : null, loc.elements[0] ? `element \`${cap(loc.elements[0].selector, 80)}\`` : null].filter(Boolean);
      const hasSource = loc.locations.length > 0 || loc.elements.length > 0;
      return `- **${i.code}** ${cap(i.title, 70)} — ${parts.join(', ')}${hasSource ? '' : `${parts.length ? '; ' : ''}no file, line or element was recorded for this issue`}`;
    });
    return `**Where the issues are**\n\n${rows.join('\n')}\n\nFile and line numbers appear only when the browser reported them (JavaScript errors and failed script requests). Ask “Explain <code>” for the full breakdown.`;
  }

  const shown = picks.slice(0, picks.length > 1 && scored[0]?.s !== undefined && scored[0].s >= 2 ? 2 : 1);
  const body = shown.map(explainOne).join('\n\n---\n\n');
  const rest = ctx.issues.length - shown.length;
  return `${body}${rest > 0 ? `\n\n---\n\nThere ${rest === 1 ? 'is' : 'are'} ${plural(rest, 'other issue')} in this report. Ask “What should I fix first?” or name an issue code to see it.` : ''}`;
}

/** Quick prompts based on the real report (used when no AI is available to generate them). */
export function suggestPrompts(ctx: ChatContext): string[] {
  const out: string[] = [];
  const top = [...ctx.issues].sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9))[0];
  if (top) out.push(`Explain ${top.code}: ${cap(top.title, 50)}`);
  if (ctx.issues.length > 1) out.push('What should I fix first?');
  if (ctx.issues.some((i) => locateEvidence(i.evidence).locations.length)) out.push('Which file and line caused the errors?');
  out.push(ctx.issues.length === 0 ? 'What was and was not tested?' : 'Summarise this report');
  return out.slice(0, 4);
}
