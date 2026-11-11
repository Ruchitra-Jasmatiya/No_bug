import type { CheckOutcome } from '@nba/shared';
import { safeFetch } from '@nba/shared/net';
import { fetchFailureOutcome, fetchPage, resolveUrl } from '../lib/html.js';
import { skipUnlessHtml } from '../browser/open-page.js';
import type { ModuleResult, TestModule } from './types.js';

const MAX_LINKS = 40;
const CONCURRENCY = 5;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
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

export const linksModule: TestModule = {
  id: 'links_resources',
  async run(ctx): Promise<ModuleResult> {
    const skip = skipUnlessHtml(ctx, 'Link testing');
    if (skip) return skip;
    let page;
    try {
      page = await fetchPage(ctx);
    } catch (err) {
      return fetchFailureOutcome('Link testing', err);
    }
    const { $, url } = page;
    const out: CheckOutcome[] = [];

    const links = new Map<string, { text: string; external: boolean }>();
    let emptyHrefs = 0;
    let javascriptHrefs = 0;
    $('a').each((_, e) => {
      const href = ($(e).attr('href') ?? '').trim();
      if (href === '' || href === '#') {
        if ($(e).attr('href') !== undefined) emptyHrefs++;
        return;
      }
      if (/^javascript:/i.test(href)) return void javascriptHrefs++;
      if (/^(mailto:|tel:|sms:|data:|blob:)/i.test(href)) return;
      const u = resolveUrl(href, url);
      if (!u || !/^https?:$/.test(u.protocol)) return;
      u.hash = '';
      if (!links.has(u.href)) links.set(u.href, { text: $(e).text().trim().slice(0, 60), external: u.origin !== new URL(url).origin });
    });

    if (emptyHrefs > 0) out.push({ checkKey: 'placeholder_links', title: 'Placeholder links', status: 'warning', severity: 'low', confidence: 'confirmed', affectedUrl: url, message: `${emptyHrefs} link(s) have an empty or "#" href and go nowhere.`, evidence: { count: emptyHrefs }, recommendation: 'Point these links at real destinations or turn them into buttons.' });
    if (javascriptHrefs > 0) out.push({ checkKey: 'javascript_links', title: 'javascript: links', status: 'warning', severity: 'low', confidence: 'confirmed', affectedUrl: url, message: `${javascriptHrefs} link(s) use javascript: URLs, which break middle-click, crawling and CSP.`, recommendation: 'Use real URLs or <button> elements.' });

    const list = [...links.entries()];
    const toCheck = list.slice(0, MAX_LINKS);
    const checked = await mapLimit(toCheck, CONCURRENCY, async ([href, meta]) => {
      try {
        let r = await safeFetch(href, { method: 'HEAD', policy: ctx.policy, timeoutMs: 10_000, maxBytes: 4096, readBody: false, signal: ctx.signal });
        if (r.status === 405 || r.status === 501 || r.status === 403) r = await safeFetch(href, { policy: ctx.policy, timeoutMs: 10_000, maxBytes: 4096, signal: ctx.signal });
        return { href, ...meta, status: r.status, redirects: r.redirects.length, error: null as string | null, finalUrl: r.finalUrl };
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'error';
        return { href, ...meta, status: 0, redirects: 0, error: code === 'blocked' ? 'blocked_private' : code, finalUrl: href };
      }
    });

    const broken = checked.filter((c) => (c.status >= 400 && c.status !== 401 && c.status !== 403 && c.status !== 429 && c.status !== 999) || (c.status === 0 && c.error && c.error !== 'blocked_private'));
    const restricted = checked.filter((c) => [401, 403, 429, 999].includes(c.status));
    const loops = checked.filter((c) => c.error === 'redirect_loop' || c.error === 'too_many_redirects');
    const longChains = checked.filter((c) => c.redirects >= 3);

    for (const b of broken.slice(0, 15)) {
      out.push({ checkKey: `broken_link_${Buffer.from(b.href).toString('base64url').slice(0, 40)}`, title: 'Broken link', status: 'fail', severity: b.external ? 'low' : 'medium', confidence: 'confirmed', affectedUrl: b.href, message: b.status ? `Link "${b.text || b.href}" returns HTTP ${b.status}.` : `Link "${b.text || b.href}" could not be reached (${b.error}).`, evidence: { href: b.href, text: b.text, status: b.status, error: b.error, external: b.external }, recommendation: 'Fix the URL, restore the missing page, or remove the link.' });
    }
    if (loops.length) out.push({ checkKey: 'redirect_loops', title: 'Redirect loops', status: 'fail', severity: 'high', confidence: 'confirmed', affectedUrl: loops[0]!.href, message: `${loops.length} link(s) redirect endlessly.`, evidence: { urls: loops.map((l) => l.href).slice(0, 10) }, recommendation: 'Fix the redirect rules for these URLs.' });
    if (longChains.length) out.push({ checkKey: 'redirect_chains', title: 'Long redirect chains', status: 'warning', severity: 'low', confidence: 'confirmed', affectedUrl: longChains[0]!.href, message: `${longChains.length} link(s) go through three or more redirects.`, evidence: { urls: longChains.map((l) => ({ href: l.href, hops: l.redirects })).slice(0, 10) }, recommendation: 'Link directly to the final URL.' });
    if (restricted.length) out.push({ checkKey: 'restricted_links', title: 'Links that refused automated checks', status: 'info', severity: 'informational', confidence: 'informational', message: `${restricted.length} link(s) answered 401/403/429, which commonly means bot protection or login; they could not be verified.`, evidence: { urls: restricted.map((r) => r.href).slice(0, 10) } });
    if (broken.length === 0 && loops.length === 0) out.push({ checkKey: 'links_ok', title: 'Links resolve', status: 'pass', affectedUrl: url, message: `${checked.length - restricted.length} checked link(s) responded successfully.`, evidence: { checked: checked.length } });
    if (list.length > MAX_LINKS) out.push({ checkKey: 'links_limit', title: 'Link check limit', status: 'info', severity: 'informational', confidence: 'informational', message: `The page has ${list.length} unique links; the first ${MAX_LINKS} were checked to keep the test polite and fast.` });

    // Images ----------------------------------------------------------------------------------
    const imgs = [...new Set($('img[src]').toArray().map((e) => resolveUrl($(e).attr('src'), url)?.href).filter((u): u is string => !!u && /^https?:/.test(u)))].slice(0, 30);
    const imgResults = await mapLimit(imgs, CONCURRENCY, async (src) => {
      try {
        const r = await safeFetch(src, { method: 'HEAD', policy: ctx.policy, timeoutMs: 10_000, maxBytes: 4096, readBody: false, signal: ctx.signal });
        return { src, status: r.status, type: r.headers['content-type'] ?? '', size: Number(r.headers['content-length'] ?? 0) };
      } catch {
        return { src, status: 0, type: '', size: 0 };
      }
    });
    const badImgs = imgResults.filter((i) => i.status >= 400 || i.status === 0);
    if (badImgs.length) out.push({ checkKey: 'broken_images', title: 'Broken images', status: 'fail', severity: 'medium', confidence: 'confirmed', affectedUrl: badImgs[0]!.src, message: `${badImgs.length} image(s) fail to load.`, evidence: { images: badImgs.slice(0, 10) }, recommendation: 'Fix the image URLs or restore the files.' });
    else if (imgs.length) out.push({ checkKey: 'images_ok', title: 'Images load', status: 'pass', affectedUrl: url, message: `${imgs.length} image(s) responded successfully.` });
    const heavy = imgResults.filter((i) => i.size > 1_000_000);
    if (heavy.length) out.push({ checkKey: 'heavy_images', title: 'Oversized images', status: 'warning', severity: 'low', confidence: 'confirmed', affectedUrl: heavy[0]!.src, message: `${heavy.length} image(s) are larger than 1 MB.`, evidence: { images: heavy.slice(0, 10) }, recommendation: 'Compress images and serve modern formats (WebP/AVIF) at display size.' });

    return { status: 'completed', outcomes: out };
  },
};
