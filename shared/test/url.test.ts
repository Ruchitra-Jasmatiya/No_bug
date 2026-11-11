import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeTargetUrl } from '../src/url.js';
import { createTestSchema } from '../src/schemas.js';
import { resolveModules, IMPLEMENTED_MODULES } from '../src/constants.js';

describe('normalizeTargetUrl', () => {
  it('accepts a normal https URL', () => {
    const r = normalizeTargetUrl('https://example.com/path?q=1#frag');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.hostname, 'example.com');
      assert.equal(r.url, 'https://example.com/path?q=1');
    }
  });

  it('adds https:// when the scheme is missing', () => {
    const r = normalizeTargetUrl('example.com');
    assert.equal(r.ok && r.url, 'https://example.com/');
  });

  it('accepts host:port without scheme', () => {
    const r = normalizeTargetUrl('example.com:8443/app');
    assert.equal(r.ok && r.url, 'https://example.com:8443/app');
  });

  const rejected: Array<[string, string]> = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['javascript:alert(1)', 'unsupported_scheme'],
    ['file:///etc/passwd', 'unsupported_scheme'],
    ['ftp://example.com', 'unsupported_scheme'],
    ['data:text/html,hi', 'unsupported_scheme'],
    ['gopher://example.com', 'unsupported_scheme'],
    ['https://user:pass@example.com', 'credentials_in_url'],
    ['http://localhost', 'blocked_hostname'],
    ['http://LOCALHOST./', 'blocked_hostname'],
    ['http://printer.local', 'blocked_hostname'],
    ['http://metadata.google.internal', 'blocked_hostname'],
    ['http://service.internal/', 'blocked_hostname'],
    ['http://intranet', 'invalid'],
    ['https://example.com:22', 'blocked_port'],
    ['https://example.com:6379', 'blocked_port'],
    ['http://', 'invalid'],
    ['https://exa mple.com', 'invalid'],
  ];
  for (const [input, code] of rejected) {
    it(`rejects ${JSON.stringify(input)} (${code})`, () => {
      const r = normalizeTargetUrl(input);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, code);
    });
  }

  it('rejects over-long input', () => {
    const r = normalizeTargetUrl(`https://example.com/${'a'.repeat(3000)}`);
    assert.equal(r.ok === false && r.code, 'too_long');
  });

  it('canonicalises obfuscated loopback literals, which the IP guard then blocks', () => {
    const r = normalizeTargetUrl('http://2130706433/');
    assert.equal(r.ok && r.hostname, '127.0.0.1');
  });

  it('relaxed mode (dev/test only) permits localhost and odd ports', () => {
    const r = normalizeTargetUrl('http://127.0.0.1:54321/x', { relaxed: true });
    assert.equal(r.ok, true);
    assert.equal(normalizeTargetUrl('http://127.0.0.1:54321/x').ok, false);
  });
});

describe('createTestSchema', () => {
  it('requires authorisation confirmation', () => {
    const r = createTestSchema.safeParse({ url: 'https://example.com' });
    assert.equal(r.success, false);
    const ok = createTestSchema.safeParse({ url: 'https://example.com', authorizationConfirmed: true });
    assert.equal(ok.success, true);
  });
  it('rejects unknown modules', () => {
    const r = createTestSchema.safeParse({ url: 'https://example.com', authorizationConfirmed: true, modules: ['nope'] });
    assert.equal(r.success, false);
  });
});

describe('resolveModules', () => {
  it('always includes system modules and only implemented defaults', () => {
    const ids = resolveModules();
    for (const m of ['connectivity', 'browser_launch', 'page_inspection', 'ai_analysis', 'report_generation'] as const) {
      assert.ok(ids.includes(m), m);
    }
    for (const m of IMPLEMENTED_MODULES) assert.ok(ids.includes(m), m);
  });
  it('keeps registry order', () => {
    const ids = resolveModules(['report_generation', 'connectivity']);
    assert.equal(ids[0], 'connectivity');
    assert.equal(ids[ids.length - 1], 'report_generation');
  });
});
