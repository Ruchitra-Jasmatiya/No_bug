import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { CheckOutcome } from '@nba/shared';
import { safeFetch } from '@nba/shared/net';
import { fetchFailureOutcome, fetchPage, resolveUrl } from '../lib/html.js';
import { navigationBlocked, skipUnlessHtml, withPage } from '../browser/open-page.js';
import type { ModuleContext, ModuleResult, TestModule } from './types.js';

/**
 * Pagination testing. Everything reported here was observed: the pager controls found in the page's HTML, the
 * pages they lead to (fetched and compared), the chain of "next" links (followed), and, for JavaScript
 * controls such as "Load more", a real click in the browser. A page without any pagination is reported as
 * "skipped (not applicable)", never as a pass.
 */

const MAX_NUMBERED_PAGES = 8;
const MAX_CHAIN_HOPS = 4;
const FETCH_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 8_000;

const NEXT_TEXT = /^(next|next page|older|older posts|›|»|→|>)$|^next\b/i;
const PREV_TEXT = /^(prev|previous|previous page|newer|newer posts|‹|«|←|<)$|^prev(ious)?\b/i;
const PAGER_CONTAINER = '[class*="pagination" i],[class*="pager" i],[class*="page-numbers" i],[id*="pagination" i],nav[aria-label*="pagination" i],nav[aria-label*="page" i],[role="navigation"][aria-label*="page" i]';
const PAGE_PARAM = /[?&](page|p|paged|pg|pageno|pagenumber)=(\d+)/i;
const PAGE_PATH = /\/page\/(\d+)\/?$/i;
const JS_MORE_TEXT = /^(next|next page|load more|show more|view more|see more|more|older posts)\b/i;
const UNSAFE_LABEL = /delete|remove|buy|purchase|pay|checkout|order|submit|subscribe|sign.?out|log.?out|confirm|cancel|reset|clear|erase|publish/i;

interface Detected {
  numbered: Map<number, string>;
  next: string | null;
  prev: string | null;
  relNext: string | null;
  hasPagerContainer: boolean;
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

const clean = (u: URL): string => {
  u.hash = '';
  return u.href;
};

export function detectPagination($: cheerio.CheerioAPI, pageUrl: string): Detected {
  const origin = new URL(pageUrl).origin;
  const numbered = new Map<number, string>();
  let next: string | null = null;
  let prev: string | null = null;

  const resolveSame = (href: string | undefined): string | null => {
    const u = resolveUrl(href, pageUrl);
    if (!u || u.origin !== origin || !/^https?:$/.test(u.protocol)) return null;
    return clean(u);
  };

  const relNextHref = $('link[rel~="next"]').attr('href') ?? $('a[rel~="next"]').first().attr('href');
  const relPrevHref = $('link[rel~="prev"]').attr('href') ?? $('a[rel~="prev"]').first().attr('href');
  const relNext = resolveSame(relNextHref);
  if (relNext) next = relNext;
  const relPrev = resolveSame(relPrevHref);
  if (relPrev) prev = relPrev;

  const containers = $(PAGER_CONTAINER);
  containers.find('a[href]').each((_, el) => {
    const a = $(el);
    const text = a.text().replace(/\s+/g, ' ').trim();
    const label = `${text} ${a.attr('aria-label') ?? ''} ${a.attr('title') ?? ''}`.trim();
    const target = resolveSame(a.attr('href'));
    if (!target) return;
    if (/^\d{1,4}$/.test(text)) numbered.set(Number(text), target);
    else if (NEXT_TEXT.test(text) || /\bnext\b/i.test(label)) next ??= target;
    else if (PREV_TEXT.test(text) || /\bprev(ious)?\b/i.test(label)) prev ??= target;
  });

  // Links that carry a page number even when no pager container is recognisable.
  $('a[href]').each((_, el) => {
    const target = resolveSame($(el).attr('href'));
    if (!target) return;
    const m = PAGE_PARAM.exec(target) ?? PAGE_PATH.exec(new URL(target).pathname);
    if (!m) return;
    const n = Number(m[m.length - 1]);
    if (n >= 1 && n <= 9999 && !numbered.has(n)) numbered.set(n, target);
  });

  return { numbered, next, prev, relNext, hasPagerContainer: containers.length > 0 };
}

interface Probe {
  url: string;
  label: string;
  status: number;
  error: string | null;
  hash: string | null;
  title: string;
  relNext: string | null;
  ms: number;
}

async function probe(ctx: ModuleContext, url: string, label: string): Promise<Probe> {
  try {
    const r = await safeFetch(url, { policy: ctx.policy, timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: 1024 * 1024, signal: ctx.signal });
    const $ = cheerio.load(r.body ?? '');
    const nextHref = $('link[rel~="next"]').attr('href') ?? $('a[rel~="next"]').first().attr('href');
    $(PAGER_CONTAINER).remove(); // compare the content the pager leads to, not the pager itself
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 30_000);
    const nu = resolveUrl(nextHref, r.finalUrl);
    return { url, label, status: r.status, error: null, hash: text ? createHash('sha1').update(text).digest('hex') : null, title: $('head > title').first().text().trim().slice(0, 100), relNext: nu ? clean(nu) : null, ms: r.timings.totalMs };
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'error';
    return { url, label, status: 0, error: code, hash: null, title: '', relNext: null, ms: 0 };
  }
}

export const paginationModule: TestModule = {
  id: 'pagination',
  async run(ctx): Promise<ModuleResult> {
    const skip = skipUnlessHtml(ctx, 'Pagination testing');
    if (skip) return skip;
    let page;
    try {
      page = await fetchPage(ctx);
    } catch (err) {
      return fetchFailureOutcome('Pagination testing', err);
    }
    const { $, url } = page;
    const out: CheckOutcome[] = [];

    const found = detectPagination($, url);
    const hasLinks = found.numbered.size > 0 || !!found.next || !!found.prev;

    // Controls that are buttons or "#" links need a real browser; look for them before deciding "no pagination".
    const jsCandidates = hasLinks ? [] : $('button, [role="button"], a[href="#"], a[href^="javascript:"]').toArray().map((e) => $(e).text().replace(/\s+/g, ' ').trim()).filter((t) => JS_MORE_TEXT.test(t) && !UNSAFE_LABEL.test(t));

    if (!hasLinks && jsCandidates.length === 0) {
      out.push({ checkKey: 'pagination_none', title: 'Pagination', status: 'skipped', severity: 'informational', confidence: 'informational', affectedUrl: url, message: 'Not applicable: no pagination controls (page numbers, next/previous links or "load more" buttons) were found on the tested page, so there was nothing to verify.', evidence: { pagerContainers: found.hasPagerContainer } });
      return { status: 'completed', outcomes: out };
    }

    if (hasLinks) {
      // --- 1. every pagination link must load, and each page must show different content -------------
      const targets = new Map<string, string>();
      for (const [n, u] of [...found.numbered.entries()].sort((a, b) => a[0] - b[0]).slice(0, MAX_NUMBERED_PAGES)) targets.set(u, `Page ${n}`);
      if (found.next && !targets.has(found.next)) targets.set(found.next, 'Next');
      if (found.prev && !targets.has(found.prev)) targets.set(found.prev, 'Previous');
      targets.delete(url);

      const here = await probe(ctx, url, 'Current page');
      const results = await mapLimit([...targets.entries()], FETCH_CONCURRENCY, ([u, label]) => probe(ctx, u, label));

      const broken = results.filter((r) => r.status >= 400 || r.status === 0);
      const nextBroken = broken.find((r) => r.label === 'Next');
      for (const b of broken.slice(0, 10)) {
        out.push({ checkKey: `pagination_broken_${Buffer.from(b.url).toString('base64url').slice(0, 40)}`, title: `Pagination link "${b.label}" is broken`, status: 'fail', severity: b === nextBroken ? 'high' : 'medium', confidence: 'confirmed', affectedUrl: b.url, message: b.status ? `The "${b.label}" pagination link returns HTTP ${b.status}, so visitors who click it land on an error page.` : `The "${b.label}" pagination link could not be reached (${b.error}).`, evidence: { label: b.label, status: b.status, error: b.error, foundOn: url }, recommendation: 'Fix the pagination URL or the route behind it, or remove the control when there is no such page.' });
      }
      const okPages = results.filter((r) => r.status >= 200 && r.status < 400);
      if (results.length > 0 && broken.length === 0) {
        out.push({ checkKey: 'pagination_links', title: 'Pagination links load', status: 'pass', affectedUrl: url, message: `${results.length} pagination link(s) were opened and every one loaded successfully.`, evidence: { pages: results.map((r) => ({ label: r.label, url: r.url, status: r.status, ms: r.ms })) } });
      }

      const duplicates = okPages.filter((r) => r.hash && here.hash && r.hash === here.hash);
      if (duplicates.length) {
        out.push({ checkKey: 'pagination_same_content', title: 'Pagination pages show identical content', status: 'warning', severity: 'medium', confidence: 'confirmed', affectedUrl: duplicates[0]!.url, message: `${duplicates.length} paginated page(s) show exactly the same text as the current page, so the pager is not moving through different content.`, evidence: { pages: duplicates.map((d) => ({ label: d.label, url: d.url })), comparedWith: url }, recommendation: 'Check that the server applies the page parameter (for example ?page=2) when it builds the list.' });
      } else if (okPages.some((r) => r.hash && r.label.startsWith('Page'))) {
        out.push({ checkKey: 'pagination_content', title: 'Paginated pages show different content', status: 'pass', affectedUrl: url, message: 'The paginated pages that were opened each show content that differs from the current page.', evidence: { compared: okPages.length } });
      }

      // --- 2. follow the "next" chain: no loops, no dead ends ---------------------------------------
      const start = found.relNext ?? found.next;
      if (start) {
        const visited = new Set<string>([url]);
        const hops: Array<{ url: string; status: number }> = [];
        let current: string | null = start;
        let problem: { kind: 'loop' | 'self' | 'error'; url: string; status?: number } | null = null;
        for (let i = 0; i < MAX_CHAIN_HOPS && current; i++) {
          if (ctx.signal.aborted) break;
          if (current === url && i === 0) { problem = { kind: 'self', url: current }; break; }
          if (visited.has(current)) { problem = { kind: 'loop', url: current }; break; }
          visited.add(current);
          const p: Probe = await probe(ctx, current, `Next ${i + 1}`);
          hops.push({ url: current, status: p.status });
          if (p.status >= 400 || p.status === 0) { problem = { kind: 'error', url: current, status: p.status }; break; }
          current = p.relNext;
        }
        if (problem?.kind === 'self') out.push({ checkKey: 'pagination_next_self', title: 'Next link points to the same page', status: 'fail', severity: 'high', confidence: 'confirmed', affectedUrl: problem.url, message: 'The "next" link leads back to the page it is on, so the visitor can never move forward.', evidence: { page: url, next: problem.url }, recommendation: 'Point "next" at the following page (page + 1), and hide it on the last page.' });
        else if (problem?.kind === 'loop') out.push({ checkKey: 'pagination_next_loop', title: 'Pagination loops back on itself', status: 'fail', severity: 'high', confidence: 'confirmed', affectedUrl: problem.url, message: `Following "next" links returned to an already visited page (${problem.url}) after ${hops.length} step(s).`, evidence: { hops, loopsTo: problem.url }, recommendation: 'Make each page link to a new next page and omit the link on the last page.' });
        else if (problem?.kind === 'error') { /* already reported as a broken pagination link when it is one of the discovered links */
          if (!broken.some((b) => b.url === problem!.url)) out.push({ checkKey: `pagination_chain_error_${Buffer.from(problem.url).toString('base64url').slice(0, 30)}`, title: 'Next page does not load', status: 'fail', severity: 'high', confidence: 'confirmed', affectedUrl: problem.url, message: problem.status ? `Following "next" links reached a page that returns HTTP ${problem.status}.` : 'Following "next" links reached a page that could not be reached.', evidence: { hops }, recommendation: 'Fix the page or remove the "next" link that leads to it.' });
        } else if (hops.length > 0) out.push({ checkKey: 'pagination_chain', title: 'Next links lead forward', status: 'pass', affectedUrl: url, message: `${hops.length} consecutive "next" link(s) were followed; each page loaded and none looped back.`, evidence: { hops } });
      }
    }

    // --- 3. JavaScript pagination ("Load more", "Next" buttons) tested with a real click ---------------
    if (jsCandidates.length > 0) {
      try {
        const r = await withPage(ctx, { settleMs: 300 }, async (p) => {
          const handle = await p.evaluateHandle((re) => {
            const rx = new RegExp(re, 'i');
            const els = Array.from(document.querySelectorAll('button, [role="button"], a[href="#"], a[href^="javascript:"]')) as HTMLElement[];
            return els.find((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && rx.test((e.textContent ?? '').replace(/\s+/g, ' ').trim()) && !e.hasAttribute('disabled') && !e.closest('form'); }) ?? null;
          }, JS_MORE_TEXT.source);
          const el = handle.asElement();
          if (!el) return { clicked: false as const };
          const label = ((await el.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
          const snapshot = () => p.evaluate(() => ({ url: location.href, h: document.documentElement.scrollHeight, len: (document.body.innerText ?? '').length, nodes: document.body.getElementsByTagName('*').length }));
          const before = await snapshot();
          await el.click({ timeout: 3_000 });
          await p.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
          await p.waitForTimeout(400);
          const after = await snapshot();
          return { clicked: true as const, label, before, after };
        });
        if (r.clicked) {
          const changed = r.before.url !== r.after.url || r.after.len !== r.before.len || r.after.nodes !== r.before.nodes;
          out.push(changed
            ? { checkKey: 'pagination_js_control', title: `"${r.label}" control works`, status: 'pass', affectedUrl: url, message: `Clicking "${r.label}" changed the page (content or address), so the control responds.`, evidence: { label: r.label, before: r.before, after: r.after } }
            : { checkKey: 'pagination_js_control', title: `"${r.label}" control changed nothing`, status: 'warning', severity: 'medium', confidence: 'potential', affectedUrl: url, message: `Clicking "${r.label}" produced no visible change within 3 seconds. It may be disabled on the last page, or the handler may be broken.`, evidence: { label: r.label, before: r.before, after: r.after }, recommendation: 'Click the control manually with the DevTools network tab open and confirm that a request is sent and the list is updated.' });
        }
      } catch (err) {
        if (!hasLinks) return navigationBlocked('Pagination testing', err);
        out.push({ checkKey: 'pagination_js_control', title: 'Pagination button test', status: 'blocked', message: `The button-based pagination could not be tested: ${((err as Error).message ?? '').split('\n')[0]!.slice(0, 160)}` });
      }
    }

    return { status: 'completed', outcomes: out };
  },
};
