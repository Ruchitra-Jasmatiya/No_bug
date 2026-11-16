import * as cheerio from 'cheerio';
import { safeFetch, type SafeFetchResult } from '@nba/shared/net';
import type { ModuleContext } from '../modules/types.js';

export interface FetchedPage {
  res: SafeFetchResult;
  $: cheerio.CheerioAPI;
  url: string;
}

/** Rejects as soon as `signal` aborts, without cancelling the underlying shared work. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * Fetch a document through the SSRF-safe client and parse it. The download is shared by every module of the
 * same test run (SEO, links, security, PWA and functional testing all read the same HTML), so a page is
 * downloaded once instead of once per module. Callers must treat the parsed document as read-only.
 */
export function fetchPage(ctx: ModuleContext, url = ctx.target.url): Promise<FetchedPage> {
  const key = `page:${url}`;
  let shared = ctx.shared.get(key) as Promise<FetchedPage> | undefined;
  if (!shared) {
    shared = safeFetch(url, { policy: ctx.policy, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 }).then((res) => ({ res, $: cheerio.load(res.body ?? ''), url: res.finalUrl }));
    ctx.shared.set(key, shared);
    shared.catch(() => ctx.shared.delete(key)); // a failed download may be retried by the next module
  }
  return abortable(shared, ctx.signal);
}

export function resolveUrl(href: string | undefined, base: string): URL | null {
  if (!href) return null;
  try {
    return new URL(href.trim(), base);
  } catch {
    return null;
  }
}

export function fetchFailureOutcome(label: string, err: unknown) {
  const msg = ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 300);
  const note = `${label} could not fetch the page: ${msg}`;
  return { status: 'blocked' as const, note, error: note, outcomes: [{ checkKey: 'page_fetch', title: 'Page could be fetched for this module', status: 'blocked' as const, message: note }] };
}
