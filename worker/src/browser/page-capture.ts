import { isIP } from 'node:net';
import type { BrowserContext } from 'playwright';
import { isBlockedAddress } from '@nba/shared/net';
import { LIMITS } from '@nba/shared';

export interface ConsoleEvent {
  type: string;
  text: string;
  url: string;
  line: number;
  column: number;
  at: string;
}
export interface PageErrorEvent {
  message: string;
  stack: string;
  at: string;
}
export interface FailedRequest {
  url: string;
  method: string;
  resourceType: string;
  failure: string;
  at: string;
}
export interface HttpErrorEvent {
  url: string;
  status: number;
  resourceType: string;
  at: string;
}

export interface ApiCall {
  url: string;
  method: string;
  status: number;
  durationMs: number | null;
  contentType: string;
  requestAccept: string;
  crossOrigin: boolean;
  acao: string | null;
  acac: string | null;
  /** For JSON responses up to 200 KB: whether the body actually parsed. null = not checked. */
  jsonValid: boolean | null;
  at: string;
}

export interface PageCapture {
  apiCalls: ApiCall[];
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  title: string;
  navigationError: string | null;
  redirects: string[];
  documentHeaders: Record<string, string>;
  timing: { domContentLoadedMs: number | null; loadMs: number | null; firstContentfulPaintMs: number | null; ttfbMs: number | null };
  console: ConsoleEvent[];
  pageErrors: PageErrorEvent[];
  failedRequests: FailedRequest[];
  httpErrors: HttpErrorEvent[];
  /** Subresources that point at localhost or private addresses (usually a leaked development URL). */
  privateReferences: string[];
  requestCount: number;
  bytesReceived: number;
  byteLimitExceeded: boolean;
  startedAt: string;
}

export interface CaptureOptions {
  navigationTimeoutMs: number;
  signal?: AbortSignal;
  maxPageBytes?: number;
}

const DEFAULT_MAX_PAGE_BYTES = 100 * 1024 * 1024;

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  return isIP(h) !== 0 && isBlockedAddress(h);
}

/** Load a URL in a fresh page and record everything observable about the load. */
export async function capturePage(context: BrowserContext, url: string, options: CaptureOptions): Promise<PageCapture> {
  const maxBytes = options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES;
  const capture: PageCapture = {
    requestedUrl: url,
    finalUrl: url,
    status: null,
    title: '',
    navigationError: null,
    redirects: [],
    apiCalls: [],
    documentHeaders: {},
    timing: { domContentLoadedMs: null, loadMs: null, firstContentfulPaintMs: null, ttfbMs: null },
    console: [],
    pageErrors: [],
    failedRequests: [],
    httpErrors: [],
    privateReferences: [],
    requestCount: 0,
    bytesReceived: 0,
    byteLimitExceeded: false,
    startedAt: new Date().toISOString(),
  };

  const page = await context.newPage();
  const now = () => new Date().toISOString();
  const onAbort = () => void page.close().catch(() => undefined);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  page.on('console', (msg) => {
    if (capture.console.length >= LIMITS.maxConsoleEventsStored) return;
    const loc = msg.location();
    capture.console.push({ type: msg.type(), text: msg.text().slice(0, 600), url: loc.url ?? '', line: loc.lineNumber ?? 0, column: loc.columnNumber ?? 0, at: now() });
  });
  page.on('pageerror', (err) => {
    if (capture.pageErrors.length >= LIMITS.maxConsoleEventsStored) return;
    capture.pageErrors.push({ message: String(err.message ?? err).slice(0, 600), stack: (err.stack ?? '').split('\n').slice(0, 6).join('\n').slice(0, 1200), at: now() });
  });
  const pageHost = new URL(url).host.toLowerCase();
  page.on('request', (req) => {
    capture.requestCount++;
    try {
      const u = new URL(req.url());
      // Requests to the tested site's own host:port are never a "leaked development URL".
      if (u.host.toLowerCase() === pageHost) return;
      if ((u.protocol === 'http:' || u.protocol === 'https:') && isPrivateHost(u.hostname) && !capture.privateReferences.includes(req.url())) {
        if (capture.privateReferences.length < 25) capture.privateReferences.push(req.url());
      }
    } catch {
      /* non-URL request */
    }
  });
  page.on('requestfailed', (req) => {
    if (capture.failedRequests.length >= LIMITS.maxFailedRequestsStored) return;
    capture.failedRequests.push({ url: req.url(), method: req.method(), resourceType: req.resourceType(), failure: req.failure()?.errorText ?? 'unknown', at: now() });
  });
  const pending: Array<Promise<void>> = [];
  page.on('response', (res) => {
    const req = res.request();
    const type = req.resourceType();
    if ((type === 'xhr' || type === 'fetch') && capture.apiCalls.length < 100) {
      const headers = res.headers();
      const call: ApiCall = {
        url: res.url(),
        method: req.method(),
        status: res.status(),
        durationMs: null,
        contentType: headers['content-type'] ?? '',
        requestAccept: req.headers()['accept'] ?? '',
        crossOrigin: (() => {
          try {
            return new URL(res.url()).origin !== new URL(url).origin;
          } catch {
            return false;
          }
        })(),
        acao: headers['access-control-allow-origin'] ?? null,
        acac: headers['access-control-allow-credentials'] ?? null,
        jsonValid: null,
        at: now(),
      };
      capture.apiCalls.push(call);
      pending.push(
        (async () => {
          try {
            await res.finished();
            const t = req.timing();
            call.durationMs = t.responseEnd >= 0 ? Math.round(t.responseEnd) : null;
            if (/json/i.test(call.contentType) && res.status() !== 204) {
              const body = await res.body();
              if (body.byteLength <= 200 * 1024) {
                try {
                  JSON.parse(body.toString('utf8'));
                  call.jsonValid = true;
                } catch {
                  call.jsonValid = false;
                }
              }
            }
          } catch {
            /* body unavailable (aborted / redirected) */
          }
        })(),
      );
    }
    if (res.status() < 400 || capture.httpErrors.length >= LIMITS.maxFailedRequestsStored) return;
    if (type === 'document' && req.frame() === page.mainFrame()) return; // reported as the page status
    capture.httpErrors.push({ url: res.url(), status: res.status(), resourceType: type, at: now() });
  });

  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.dataReceived', (e: { dataLength: number }) => {
      capture.bytesReceived += e.dataLength;
      if (capture.bytesReceived > maxBytes && !capture.byteLimitExceeded) {
        capture.byteLimitExceeded = true;
        void page.close().catch(() => undefined); // enforce the download cap
      }
    });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeoutMs });
    if (response) {
      capture.status = response.status();
      capture.documentHeaders = await response.allHeaders().catch(() => ({}));
      let req = response.request().redirectedFrom();
      while (req && capture.redirects.length < 10) {
        capture.redirects.unshift(req.url());
        req = req.redirectedFrom();
      }
    }
    await page.waitForLoadState('load', { timeout: Math.min(options.navigationTimeoutMs, 20_000) }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined); // best effort

    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 3000))]);
    capture.finalUrl = page.url();
    capture.title = (await page.title().catch(() => '')).slice(0, 300);
    const t = await page
      .evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        const fcp = performance.getEntriesByName('first-contentful-paint')[0];
        return {
          dcl: nav?.domContentLoadedEventEnd ?? null,
          load: nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : null,
          fcp: fcp?.startTime ?? null,
          ttfb: nav?.responseStart ?? null,
        };
      })
      .catch(() => null);
    if (t) {
      const r = (n: number | null) => (n === null ? null : Math.round(n));
      capture.timing = { domContentLoadedMs: r(t.dcl), loadMs: r(t.load), firstContentfulPaintMs: r(t.fcp), ttfbMs: r(t.ttfb) };
    }
  } catch (err) {
    capture.navigationError = ((err as Error).message ?? 'Navigation failed').split('\n')[0]!.slice(0, 400);
    try {
      capture.finalUrl = page.url() || url;
    } catch {
      /* page closed */
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await page.close().catch(() => undefined);
  }
  return capture;
}
