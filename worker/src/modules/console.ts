import type { CheckOutcome } from '@nba/shared';
import type { PageCapture } from '../browser/page-capture.js';
import type { ModuleResult, TestModule } from './types.js';

type StoredCapture = Pick<PageCapture, 'finalUrl' | 'console' | 'pageErrors' | 'failedRequests' | 'httpErrors' | 'startedAt'>;

/** Analyses what page_inspection recorded. Reads the durable checkpoint, so it works after a restart. */
export const consoleModule: TestModule = {
  id: 'console',
  async run(ctx): Promise<ModuleResult> {
    const prior = ctx.prior('page_inspection');
    const capture = (prior?.checkpoint as { capture?: StoredCapture } | undefined)?.capture;
    if (!prior || prior.status !== 'completed' || !capture) {
      return { status: 'blocked', note: 'Requires a completed page inspection, which was not available.', outcomes: [] };
    }

    const outcomes: CheckOutcome[] = [];
    const page = capture.finalUrl;

    const errors = capture.console.filter((c) => c.type === 'error');
    const warnings = capture.console.filter((c) => c.type === 'warning');

    if (capture.pageErrors.length === 0) {
      outcomes.push({ checkKey: 'unhandled_exceptions', title: 'No unhandled JavaScript exceptions', status: 'pass', message: 'No unhandled exceptions or promise rejections were raised while the page loaded.', affectedUrl: page, evidence: {} });
    } else {
      for (const [i, e] of capture.pageErrors.slice(0, 10).entries()) {
        outcomes.push({
          checkKey: `exception_${i}_${hash(e.message)}`,
          title: 'Unhandled JavaScript exception',
          status: 'fail',
          severity: 'high',
          confidence: 'confirmed',
          affectedUrl: page,
          message: e.message,
          evidence: { message: e.message, stack: e.stack, observedAt: e.at },
          recommendation: 'Open the browser DevTools console on this page, reproduce the exception, and use the stack trace to locate the failing code. Guard against undefined values and wrap risky calls in error handling.',
        });
      }
    }

    // Console "error" messages that are not already covered by a network failure.
    const resourceNoise = /Failed to load resource/i;
    const appErrors = errors.filter((e) => !resourceNoise.test(e.text));
    if (appErrors.length === 0) {
      outcomes.push({ checkKey: 'console_errors', title: 'No console errors', status: 'pass', message: 'The browser console reported no application errors during page load.', affectedUrl: page, evidence: {} });
    } else {
      const unique = uniqueBy(appErrors, (e) => e.text);
      for (const [i, e] of unique.slice(0, 10).entries()) {
        outcomes.push({
          checkKey: `console_error_${i}_${hash(e.text)}`,
          title: 'Console error',
          status: 'fail',
          severity: 'medium',
          confidence: 'confirmed',
          affectedUrl: e.url || page,
          message: e.text,
          evidence: { text: e.text, source: e.url, line: e.line, column: e.column, observedAt: e.at, occurrences: appErrors.filter((x) => x.text === e.text).length },
          recommendation: 'Reproduce the error in the DevTools console, locate the source file and line shown in the evidence, and fix the underlying cause.',
        });
      }
    }

    if (warnings.length > 0) {
      outcomes.push({
        checkKey: 'console_warnings',
        title: 'Browser console warnings',
        status: 'warning',
        severity: 'low',
        confidence: 'confirmed',
        affectedUrl: page,
        message: `${warnings.length} console warning(s) were logged during page load.`,
        evidence: { samples: uniqueBy(warnings, (w) => w.text).slice(0, 8).map((w) => ({ text: w.text, source: w.url, at: w.at })) },
        recommendation: 'Review the warnings; they often flag deprecated APIs or misconfigurations that will become errors in future browser versions.',
      });
    }

    // Failed network requests ----------------------------------------------------------------------
    if (capture.failedRequests.length === 0 && capture.httpErrors.length === 0) {
      outcomes.push({ checkKey: 'failed_requests', title: 'No failed network requests', status: 'pass', message: 'Every request made while the page loaded completed successfully.', affectedUrl: page, evidence: {} });
    }
    for (const r of capture.failedRequests.slice(0, 15)) {
      const policyBlocked = /BLOCKED_BY_CLIENT|ERR_PROXY|ERR_TUNNEL|ERR_BLOCKED/i.test(r.failure);
      outcomes.push({
        checkKey: `request_failed_${hash(r.url)}`,
        title: `Failed ${r.resourceType} request`,
        status: policyBlocked ? 'info' : 'fail',
        severity: r.resourceType === 'script' || r.resourceType === 'stylesheet' ? 'high' : 'medium',
        confidence: policyBlocked ? 'informational' : 'confirmed',
        affectedUrl: r.url,
        message: policyBlocked ? `The request was refused by the testing sandbox (${r.failure}); this may be a private-network destination.` : `${r.method} ${r.url} failed: ${r.failure}.`,
        evidence: { url: r.url, method: r.method, resourceType: r.resourceType, failure: r.failure, observedAt: r.at },
        recommendation: 'Confirm the resource URL is correct and publicly reachable, that the server is up, and that CORS and certificates are configured correctly.',
      });
    }
    for (const r of capture.httpErrors.slice(0, 15)) {
      outcomes.push({
        checkKey: `http_error_${r.status}_${hash(r.url)}`,
        title: `${r.resourceType} request returned HTTP ${r.status}`,
        status: 'fail',
        severity: r.status >= 500 ? 'high' : r.resourceType === 'script' || r.resourceType === 'stylesheet' ? 'high' : 'medium',
        confidence: 'confirmed',
        affectedUrl: r.url,
        message: `${r.url} answered HTTP ${r.status}.`,
        evidence: { url: r.url, status: r.status, resourceType: r.resourceType, observedAt: r.at },
        recommendation: r.status === 404 ? 'The resource does not exist at this URL. Fix the path in your HTML or code, or restore the missing file.' : 'Check the server logs for this URL and fix the cause of the error response.',
      });
    }

    return { status: 'completed', outcomes, checkpoint: { errors: errors.length, warnings: warnings.length, exceptions: capture.pageErrors.length, failedRequests: capture.failedRequests.length, httpErrors: capture.httpErrors.length } };
  },
};

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
