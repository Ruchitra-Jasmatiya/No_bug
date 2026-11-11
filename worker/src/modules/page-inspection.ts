import type { CheckOutcome } from '@nba/shared';
import { capturePage, type PageCapture } from '../browser/page-capture.js';
import { BOT_USER_AGENT_SUFFIX } from '../browser/session.js';
import type { ModuleResult, TestModule } from './types.js';

/** The slice of a capture that later modules need. Small enough to persist as a checkpoint. */
export function toCheckpoint(c: PageCapture): Record<string, unknown> {
  return {
    capture: {
      requestedUrl: c.requestedUrl,
      finalUrl: c.finalUrl,
      status: c.status,
      title: c.title,
      navigationError: c.navigationError,
      redirects: c.redirects,
      timing: c.timing,
      console: c.console.slice(0, 100),
      pageErrors: c.pageErrors.slice(0, 50),
      failedRequests: c.failedRequests.slice(0, 100),
      httpErrors: c.httpErrors.slice(0, 100),
      apiCalls: c.apiCalls.slice(0, 60),
      privateReferences: c.privateReferences,
      requestCount: c.requestCount,
      bytesReceived: c.bytesReceived,
      startedAt: c.startedAt,
    },
  };
}

export const pageInspectionModule: TestModule = {
  id: 'page_inspection',
  async run(ctx): Promise<ModuleResult> {
    const browser = await ctx.browser();
    const context = await browser.newContext({ userAgent: undefined });
    let capture: PageCapture;
    try {
      capture = await capturePage(context, ctx.target.url, {
        navigationTimeoutMs: ctx.settings.timeouts.navigationMs,
        signal: ctx.signal,
        maxPageBytes: ctx.settings.crawl.maxDownloadBytes * 20,
      });
    } finally {
      await context.close().catch(() => undefined);
    }

    const outcomes: CheckOutcome[] = [];
    const blocked = browser.blockedByPolicy;

    if (capture.navigationError && capture.status === null) {
      outcomes.push({
        checkKey: 'page_load',
        title: 'Page loads in a real browser',
        status: 'fail',
        severity: 'critical',
        confidence: 'confirmed',
        affectedUrl: ctx.target.url,
        message: `The browser could not load the page: ${capture.navigationError}`,
        evidence: { error: capture.navigationError, blockedByPolicy: blocked.slice(0, 10) },
        recommendation: 'Confirm the page loads for ordinary visitors. Check for slow or failing server responses, certificate problems, or blocking of automated browsers.',
      });
      return { status: 'completed', outcomes, checkpoint: toCheckpoint(capture), fatal: 'The page could not be loaded in the browser.' };
    }

    const status = capture.status ?? 0;
    outcomes.push({
      checkKey: 'page_load',
      title: 'Page loads in a real browser',
      status: status >= 500 ? 'fail' : status >= 400 ? 'fail' : capture.navigationError ? 'warning' : 'pass',
      severity: status >= 500 ? 'critical' : status >= 400 ? 'high' : 'low',
      confidence: 'confirmed',
      affectedUrl: capture.finalUrl,
      message: capture.navigationError
        ? `The page responded (${status}) but did not finish loading cleanly: ${capture.navigationError}`
        : `The page loaded with HTTP ${status}${capture.title ? ` and the title "${capture.title}"` : ''}.`,
      evidence: { status, finalUrl: capture.finalUrl, title: capture.title, requests: capture.requestCount, bytesReceived: capture.bytesReceived, navigationError: capture.navigationError },
      recommendation: status >= 400 ? 'Fix the server response for this URL so ordinary visitors receive a successful page.' : 'Investigate why the page did not reach the load event; a script or request may be hanging.',
    });

    if (capture.redirects.length > 0 && new URL(capture.finalUrl).origin !== new URL(ctx.target.url).origin) {
      outcomes.push({
        checkKey: 'unexpected_redirect',
        title: 'Redirect to a different site',
        status: 'info',
        severity: 'informational',
        message: `The page ended on a different origin (${new URL(capture.finalUrl).origin}) than the one requested.`,
        affectedUrl: ctx.target.url,
        evidence: { requested: ctx.target.url, final: capture.finalUrl, hops: capture.redirects },
      });
    }

    const t = capture.timing;
    if (t.loadMs !== null) {
      const slow = t.loadMs > 8000;
      outcomes.push({
        checkKey: 'load_event_time',
        title: 'Page load time (browser load event)',
        status: slow ? 'warning' : 'pass',
        severity: 'medium',
        confidence: 'confirmed',
        affectedUrl: capture.finalUrl,
        message: `The load event fired after ${t.loadMs} ms${t.firstContentfulPaintMs !== null ? `, first content painted at ${t.firstContentfulPaintMs} ms` : ''}. This is a single measurement from one location, not a full performance audit.`,
        evidence: { ...t },
        recommendation: 'Reduce render-blocking resources, compress and lazy-load images, and enable caching or a CDN. The Performance module gives a detailed Lighthouse analysis.',
      });
    } else {
      outcomes.push({ checkKey: 'load_event_time', title: 'Page load time (browser load event)', status: 'skipped', message: 'The browser did not report a load event time for this page.', evidence: { ...t } });
    }

    if (capture.privateReferences.length > 0) {
      outcomes.push({
        checkKey: 'private_references',
        title: 'Page references localhost or private network addresses',
        status: 'fail',
        severity: 'medium',
        confidence: 'confirmed',
        affectedUrl: capture.finalUrl,
        message: `${capture.privateReferences.length} request(s) point at localhost or private addresses, which will fail for real visitors (often a leftover development URL). These requests were blocked by the testing sandbox.`,
        evidence: { urls: capture.privateReferences, blockedByPolicy: blocked.slice(0, 10) },
        recommendation: 'Replace hard-coded localhost / private URLs with the production addresses, typically via environment-specific configuration.',
      });
    }

    if (capture.byteLimitExceeded) {
      outcomes.push({ checkKey: 'page_weight', title: 'Total page weight', status: 'warning', severity: 'medium', confidence: 'confirmed', affectedUrl: capture.finalUrl, message: 'The page transferred more data than the per-test limit, so loading was stopped early.', evidence: { bytesReceived: capture.bytesReceived }, recommendation: 'Reduce the total download size: compress images, split bundles and defer non-critical assets.' });
    }

    void BOT_USER_AGENT_SUFFIX;
    return { status: 'completed', outcomes, checkpoint: toCheckpoint(capture) };
  },
};
