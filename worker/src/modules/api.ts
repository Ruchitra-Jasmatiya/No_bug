import type { CheckOutcome } from '@nba/shared';
import type { ApiCall } from '../browser/page-capture.js';
import type { ModuleResult, TestModule } from './types.js';

/** Analyses the XHR/fetch calls the page made on its own while loading. No requests are invented or replayed. */
export const apiModule: TestModule = {
  id: 'api',
  async run(ctx): Promise<ModuleResult> {
    const prior = ctx.prior('page_inspection');
    const cap = (prior?.checkpoint as { capture?: { apiCalls?: ApiCall[]; finalUrl: string } } | undefined)?.capture;
    if (!prior || prior.status !== 'completed' || !cap) return { status: 'blocked', note: 'Requires a completed page inspection, which was not available.', outcomes: [] };
    const calls = cap.apiCalls ?? [];
    const out: CheckOutcome[] = [];
    if (calls.length === 0) {
      return { status: 'completed', outcomes: [{ checkKey: 'no_api_calls', title: 'API calls observed', status: 'info', severity: 'informational', confidence: 'informational', affectedUrl: cap.finalUrl, message: 'The page made no XHR/fetch calls while loading, so there was nothing to inspect. API calls triggered by user actions are not covered.' }] };
    }
    let problems = 0;
    for (const c of calls) {
      const where = `${c.method} ${c.url}`;
      const key = Buffer.from(where).toString('base64url').slice(0, 40);
      if (c.status >= 500) { problems++; out.push({ checkKey: `api_5xx_${key}`, title: 'API server error', status: 'fail', severity: 'high', confidence: 'confirmed', affectedUrl: c.url, message: `${where} returned HTTP ${c.status}.`, evidence: { ...c }, recommendation: 'Check the server logs for this endpoint and fix the failing handler.' }); }
      else if (c.status >= 400) { problems++; out.push({ checkKey: `api_4xx_${key}`, title: 'API client error', status: 'fail', severity: 'medium', confidence: 'confirmed', affectedUrl: c.url, message: `${where} returned HTTP ${c.status} during normal page load.`, evidence: { ...c }, recommendation: 'The page is calling an endpoint that rejects it: fix the URL, credentials or the missing resource.' }); }
      if (c.jsonValid === false) { problems++; out.push({ checkKey: `api_badjson_${key}`, title: 'Invalid JSON response', status: 'fail', severity: 'high', confidence: 'confirmed', affectedUrl: c.url, message: `${where} declares JSON but the body is not valid JSON.`, evidence: { ...c }, recommendation: 'Return well-formed JSON, or fix the Content-Type header.' }); }
      if (c.status < 400 && c.durationMs !== null && c.durationMs > 3000) { problems++; out.push({ checkKey: `api_slow_${key}`, title: 'Slow API response', status: 'warning', severity: 'medium', confidence: 'confirmed', affectedUrl: c.url, message: `${where} took ${c.durationMs} ms.`, evidence: { ...c }, recommendation: 'Add caching or indexes, or paginate large responses.' }); }
      if (c.crossOrigin && c.status < 400 && c.acao === '*' && c.acac === 'true') { problems++; out.push({ checkKey: `api_cors_${key}`, title: 'Unsafe CORS configuration', status: 'fail', severity: 'high', confidence: 'confirmed', affectedUrl: c.url, message: `${where} allows any origin together with credentials.`, evidence: { ...c }, recommendation: 'Echo only trusted origins when credentials are allowed.' }); }
      if (c.url.startsWith('http://') && ctx.target.url.startsWith('https://')) { problems++; out.push({ checkKey: `api_insecure_${key}`, title: 'API call over HTTP', status: 'fail', severity: 'high', confidence: 'confirmed', affectedUrl: c.url, message: `${where} uses insecure HTTP from an HTTPS page.`, evidence: { ...c }, recommendation: 'Call the API over HTTPS.' }); }
    }
    if (problems === 0) out.push({ checkKey: 'api_calls_ok', title: 'API calls healthy', status: 'pass', affectedUrl: cap.finalUrl, message: `${calls.length} API call(s) observed during load; all returned success, valid content and acceptable timing.`, evidence: { calls: calls.slice(0, 20).map((c) => ({ method: c.method, url: c.url, status: c.status, ms: c.durationMs })) } });
    out.push({ checkKey: 'api_scope', title: 'Scope of API inspection', status: 'info', severity: 'informational', confidence: 'informational', message: `Only the ${calls.length} call(s) the page makes by itself on load were inspected. Endpoints were not guessed, fuzzed or called with other credentials.` });
    return { status: 'completed', outcomes: out };
  },
};
