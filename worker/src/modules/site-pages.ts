import * as cheerio from 'cheerio';
import type { CheckOutcome } from '@nba/shared';
import { safeFetch } from '@nba/shared/net';
import { fetchFailureOutcome, fetchPage, resolveUrl } from '../lib/html.js';
import { skipUnlessHtml } from '../browser/open-page.js';
import type { ModuleResult, TestModule } from './types.js';

/**
 * Site pages & URL validation. Crawls the same-site pages linked from the start page (navigation links first),
 * up to the admin-configured page limit, and reports what each URL actually returned. Plain GET requests only:
 * nothing is clicked or submitted, and links that look like actions (log out, delete, unsubscribe ...) are never requested.
 */

const CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 8_000;
const SLOW_MS = 3_000;
const SKIP_EXT = /\.(pdf|zip|gz|rar|7z|exe|dmg|msi|mp3|mp4|mov|avi|webm|jpg|jpeg|png|gif|webp|avif|svg|ico|css|js|json|xml|txt|csv|xlsx?|docx?|pptx?)(\?|$)/i;
const ACTION_PATH = /log.?out|sign.?out|delete|remove|unsubscribe|cancel|checkout|cart|purchase|reset|confirm|\/api\//i;

interface PageProbe {
  url: string;
  finalUrl: string;
  status: number;
  error: string | null;
  ms: number;
  redirects: number;
  title: string;
  h1: number;
  description: boolean;
  noindex: boolean;
  isHtml: boolean;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]!);
      }
    }),
  );
  return results;
}

export const sitePagesModule: TestModule = {
  id: 'site_pages',
  async run(ctx): Promise<ModuleResult> {
    const skip = skipUnlessHtml(ctx, 'Site page validation');
    if (skip) return skip;
    let page;
    try {
      page = await fetchPage(ctx);
    } catch (err) {
      return fetchFailureOutcome('Site page validation', err);
    }
    const { $, url } = page;
    const origin = new URL(url).origin;
    const out: CheckOutcome[] = [];
    const limit = Math.max(1, ctx.settings.crawl.maxPages - 1);

    // Navigation links first: they are the pages visitors are most likely to open.
    const ordered: string[] = [];
    const seen = new Set<string>([url.split('#')[0]!]);
    const add = (href: string | undefined) => {
      const u = resolveUrl(href, url);
      if (!u || u.origin !== origin || !/^https?:$/.test(u.protocol)) return;
      u.hash = '';
      if (SKIP_EXT.test(u.pathname) || ACTION_PATH.test(u.pathname)) return;
      if (seen.has(u.href)) return;
      seen.add(u.href);
      ordered.push(u.href);
    };
    $('nav a[href], header a[href], [role="navigation"] a[href]').each((_, e) => add($(e).attr('href')));
    $('main a[href], a[href]').each((_, e) => add($(e).attr('href')));
    const candidates = ordered.slice(0, limit);

    if (candidates.length === 0) {
      out.push({ checkKey: 'pages_none', title: 'Site pages', status: 'skipped', severity: 'informational', confidence: 'informational', affectedUrl: url, message: 'Not applicable: the start page links to no other pages on the same site, so there were no further pages to validate.' });
      return { status: 'completed', outcomes: out };
    }

    const probes = await mapLimit(candidates, CONCURRENCY, async (u): Promise<PageProbe> => {
      try {
        const r = await safeFetch(u, { policy: ctx.policy, timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: 512 * 1024, signal: ctx.signal });
        const type = r.headers['content-type'] ?? '';
        const isHtml = /html/i.test(type) || (r.body ?? '').trimStart().startsWith('<');
        const $p = cheerio.load(isHtml ? (r.body ?? '') : '');
        return {
          url: u,
          finalUrl: r.finalUrl,
          status: r.status,
          error: null,
          ms: r.timings.totalMs,
          redirects: r.redirects.length,
          title: isHtml ? $p('head > title').first().text().trim() : '',
          h1: isHtml ? $p('h1').length : 0,
          description: isHtml ? !!$p('meta[name="description"]').attr('content')?.trim() : false,
          noindex: isHtml ? /noindex/i.test($p('meta[name="robots"]').attr('content') ?? '') : false,
          isHtml,
        };
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'error';
        return { url: u, finalUrl: u, status: 0, error: code === 'blocked' ? 'blocked_private' : code, ms: 0, redirects: 0, title: '', h1: 0, description: false, noindex: false, isHtml: false };
      }
    });

    const errors = probes.filter((p) => p.status >= 400);
    const unreachable = probes.filter((p) => p.status === 0 && p.error !== 'blocked_private');
    const good = probes.filter((p) => p.status >= 200 && p.status < 400);

    for (const p of errors.slice(0, 15)) {
      out.push({ checkKey: `page_http_${Buffer.from(p.url).toString('base64url').slice(0, 40)}`, title: `Page returns HTTP ${p.status}`, status: 'fail', severity: p.status >= 500 ? 'high' : 'medium', confidence: 'confirmed', affectedUrl: p.url, message: `${p.url} returns HTTP ${p.status}. It is linked from ${url}, so visitors can reach it.`, evidence: { url: p.url, status: p.status, linkedFrom: url }, recommendation: p.status >= 500 ? 'Check the server logs for this route; a 5xx means the application failed while building the page.' : 'Restore the page, redirect it to its new address, or remove the link that points to it.' });
    }
    for (const p of unreachable.slice(0, 10)) {
      out.push({ checkKey: `page_unreachable_${Buffer.from(p.url).toString('base64url').slice(0, 40)}`, title: 'Page could not be reached', status: 'warning', severity: 'medium', confidence: 'potential', affectedUrl: p.url, message: `${p.url} did not respond (${p.error}). This can be a real outage or a temporary network problem.`, evidence: { url: p.url, error: p.error, linkedFrom: url }, recommendation: 'Open the page in a browser. If it also fails there, check DNS, the server and any redirects for this route.' });
    }
    if (errors.length === 0 && unreachable.length === 0) {
      out.push({ checkKey: 'pages_reachable', title: 'Linked pages respond', status: 'pass', affectedUrl: url, message: `${good.length} internal page(s) linked from the start page were requested and all responded successfully.`, evidence: { pages: probes.map((p) => ({ url: p.url, status: p.status, ms: p.ms })) } });
    }

    const html = good.filter((p) => p.isHtml);
    const noTitle = html.filter((p) => !p.title);
    if (noTitle.length) out.push({ checkKey: 'pages_missing_title', title: 'Pages without a title', status: 'warning', severity: 'medium', confidence: 'confirmed', affectedUrl: noTitle[0]!.url, message: `${noTitle.length} page(s) have no <title>, which hurts search results and browser tabs.`, evidence: { pages: noTitle.map((p) => p.url).slice(0, 10) }, recommendation: 'Give each page a unique, descriptive <title>.' });
    const byTitle = new Map<string, string[]>();
    const startTitle = $('head > title').first().text().trim();
    if (startTitle) byTitle.set(startTitle.toLowerCase(), [url]); // the start page counts too
    for (const p of html) if (p.title) byTitle.set(p.title.toLowerCase(), [...(byTitle.get(p.title.toLowerCase()) ?? []), p.url]);
    const dupes = [...byTitle.entries()].filter(([, urls]) => urls.length > 1);
    if (dupes.length) out.push({ checkKey: 'pages_duplicate_titles', title: 'Pages share the same title', status: 'warning', severity: 'low', confidence: 'confirmed', affectedUrl: dupes[0]![1][0]!, message: `${dupes.length} title(s) are used by more than one page, so visitors and search engines cannot tell them apart.`, evidence: { titles: dupes.slice(0, 5).map(([t, urls]) => ({ title: t, urls: urls.slice(0, 5) })) }, recommendation: 'Write a distinct title for each page.' });
    const slow = good.filter((p) => p.ms > SLOW_MS);
    if (slow.length) out.push({ checkKey: 'pages_slow', title: 'Slow pages', status: 'warning', severity: 'low', confidence: 'confirmed', affectedUrl: slow[0]!.url, message: `${slow.length} page(s) took longer than ${SLOW_MS / 1000}s to download.`, evidence: { pages: slow.map((p) => ({ url: p.url, ms: Math.round(p.ms) })).slice(0, 10) }, recommendation: 'Profile these routes on the server (database queries, uncached rendering) and add caching where possible.' });
    const chains = good.filter((p) => p.redirects >= 2);
    if (chains.length) out.push({ checkKey: 'pages_redirect_chains', title: 'Pages behind redirect chains', status: 'warning', severity: 'low', confidence: 'confirmed', affectedUrl: chains[0]!.url, message: `${chains.length} link(s) go through two or more redirects before reaching a page.`, evidence: { pages: chains.map((p) => ({ from: p.url, to: p.finalUrl, hops: p.redirects })).slice(0, 10) }, recommendation: 'Link directly to the final address.' });
    const noindex = html.filter((p) => p.noindex);
    if (noindex.length) out.push({ checkKey: 'pages_noindex', title: 'Pages blocked from search engines', status: 'info', severity: 'informational', confidence: 'informational', affectedUrl: noindex[0]!.url, message: `${noindex.length} page(s) carry a noindex directive. That is fine for private pages, but check it is intended.`, evidence: { pages: noindex.map((p) => p.url).slice(0, 10) } });

    const total = ordered.length;
    out.push({ checkKey: 'pages_crawled', title: 'Pages checked', status: 'info', severity: 'informational', confidence: 'informational', affectedUrl: url, message: `${probes.length} internal page(s) were checked${total > probes.length ? ` (the site links to ${total}; the crawl limit is ${limit})` : ''}.`, evidence: { checked: probes.length, linked: total, limit } });

    return { status: 'completed', outcomes: out };
  },
};
