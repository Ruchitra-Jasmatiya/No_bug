import * as cheerio from 'cheerio';
import { safeFetch, type SafeFetchResult } from '@nba/shared/net';
import type { ModuleContext } from '../modules/types.js';

export interface FetchedPage {
  res: SafeFetchResult;
  $: cheerio.CheerioAPI;
  url: string;
}

/** Fetch the target document through the SSRF-safe client and parse it. Returns null if not HTML. */
export async function fetchPage(ctx: ModuleContext, url = ctx.target.url): Promise<FetchedPage> {
  const res = await safeFetch(url, { policy: ctx.policy, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024, signal: ctx.signal });
  const $ = cheerio.load(res.body ?? '');
  return { res, $, url: res.finalUrl };
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
