import type { CheckOutcome } from '@nba/shared';
import { safeFetch } from '@nba/shared/net';
import { fetchFailureOutcome, fetchPage } from '../lib/html.js';
import { skipUnlessHtml } from '../browser/open-page.js';
import type { ModuleResult, TestModule } from './types.js';

const ok = (checkKey: string, title: string, message: string, url: string, evidence = {}): CheckOutcome => ({ checkKey, title, status: 'pass', message, affectedUrl: url, evidence });

export const seoModule: TestModule = {
  id: 'seo',
  async run(ctx): Promise<ModuleResult> {
    const skip = skipUnlessHtml(ctx, 'SEO testing');
    if (skip) return skip;
    let page;
    try {
      page = await fetchPage(ctx);
    } catch (err) {
      return fetchFailureOutcome('SEO testing', err);
    }
    const { $, url, res } = page;
    const out: CheckOutcome[] = [];
    const fix = (checkKey: string, title: string, status: 'fail' | 'warning', severity: CheckOutcome['severity'], message: string, recommendation: string, evidence = {}) =>
      out.push({ checkKey, title, status, severity, confidence: 'confirmed', affectedUrl: url, message, recommendation, evidence });

    const title = $('head > title').first().text().trim();
    if (!title) fix('title', 'Page title', 'fail', 'high', 'The page has no <title>.', 'Add a unique, descriptive <title> of about 30–60 characters.');
    else if (title.length < 10 || title.length > 70) fix('title', 'Page title', 'warning', 'low', `The title is ${title.length} characters ("${title.slice(0, 80)}").`, 'Aim for roughly 30–60 characters so search results show it in full.', { title, length: title.length });
    else out.push(ok('title', 'Page title', `Title present (${title.length} characters).`, url, { title }));

    const desc = $('meta[name="description"]').attr('content')?.trim() ?? '';
    if (!desc) fix('meta_description', 'Meta description', 'warning', 'medium', 'The page has no meta description.', 'Add <meta name="description" content="…"> summarising the page in 70–160 characters.');
    else if (desc.length < 50 || desc.length > 170) fix('meta_description', 'Meta description', 'warning', 'low', `The meta description is ${desc.length} characters.`, 'Keep it between about 70 and 160 characters.', { length: desc.length });
    else out.push(ok('meta_description', 'Meta description', `Meta description present (${desc.length} characters).`, url));

    const h1 = $('h1');
    if (h1.length === 0) fix('h1', 'Main heading (h1)', 'warning', 'medium', 'The page has no <h1> heading.', 'Add one <h1> describing the page.');
    else if (h1.length > 1) fix('h1', 'Main heading (h1)', 'warning', 'low', `The page has ${h1.length} <h1> elements.`, 'Use a single <h1> and <h2>–<h6> for sub-sections.', { count: h1.length });
    else out.push(ok('h1', 'Main heading (h1)', 'Exactly one <h1> found.', url));

    const levels = $('h1,h2,h3,h4,h5,h6').toArray().map((e) => Number(e.tagName.slice(1)));
    const skipped = levels.find((l, i) => i > 0 && l - levels[i - 1]! > 1);
    if (skipped) fix('heading_order', 'Heading hierarchy', 'warning', 'low', 'Heading levels skip (for example an h2 followed directly by an h4).', 'Keep heading levels sequential without gaps.', { levels: levels.slice(0, 40) });

    const canonical = $('link[rel="canonical"]').attr('href');
    if (!canonical) fix('canonical', 'Canonical URL', 'warning', 'low', 'No canonical link is declared.', 'Add <link rel="canonical" href="…"> to avoid duplicate-content ambiguity.');
    else out.push(ok('canonical', 'Canonical URL', `Canonical: ${canonical}`, url, { canonical }));

    if (!$('meta[name="viewport"]').attr('content')) fix('viewport_meta', 'Viewport meta tag', 'fail', 'high', 'No viewport meta tag; the page will not render properly on mobile devices.', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
    else out.push(ok('viewport_meta', 'Viewport meta tag', 'Viewport meta tag present.', url));

    if (!$('html').attr('lang')) fix('html_lang', 'Document language', 'warning', 'medium', 'The <html> element has no lang attribute.', 'Add lang="en" (or the correct language) to <html>.');
    else out.push(ok('html_lang', 'Document language', `lang="${$('html').attr('lang')}".`, url));

    const robotsMeta = ($('meta[name="robots"]').attr('content') ?? '').toLowerCase();
    if (/noindex/.test(robotsMeta)) fix('noindex', 'Search engine indexing', 'warning', 'high', 'The page tells search engines not to index it (noindex).', 'Remove noindex before launch if the page should appear in search results.', { robots: robotsMeta });
    const xRobots = (res.headers['x-robots-tag'] ?? '').toLowerCase();
    if (/noindex/.test(xRobots)) fix('noindex_header', 'Search engine indexing (header)', 'warning', 'high', 'The X-Robots-Tag header contains noindex.', 'Remove noindex from the header if the page should be indexed.', { header: xRobots });

    const og = ['og:title', 'og:description', 'og:image'].filter((p) => !$(`meta[property="${p}"]`).attr('content'));
    if (og.length) fix('open_graph', 'Social sharing tags', 'warning', 'low', `Missing Open Graph tags: ${og.join(', ')}.`, 'Add Open Graph tags so shared links show a proper title, description and image.', { missing: og });
    else out.push(ok('open_graph', 'Social sharing tags', 'Open Graph title, description and image present.', url));

    const imgs = $('img');
    const noAlt = imgs.filter((_, e) => $(e).attr('alt') === undefined).length;
    if (noAlt > 0) fix('img_alt', 'Image alt text', 'warning', 'medium', `${noAlt} of ${imgs.length} image(s) have no alt attribute.`, 'Give every meaningful image descriptive alt text (alt="" for decorative images).', { missingAlt: noAlt, total: imgs.length });

    let badJson = 0;
    let jsonLd = 0;
    $('script[type="application/ld+json"]').each((_, e) => {
      jsonLd++;
      try {
        JSON.parse($(e).text());
      } catch {
        badJson++;
      }
    });
    if (badJson) fix('structured_data', 'Structured data (JSON-LD)', 'fail', 'medium', `${badJson} JSON-LD block(s) contain invalid JSON.`, 'Fix the JSON syntax; validate with a structured-data testing tool.', { blocks: jsonLd, invalid: badJson });
    else if (jsonLd) out.push(ok('structured_data', 'Structured data (JSON-LD)', `${jsonLd} JSON-LD block(s) parse correctly.`, url));

    // robots.txt and sitemap -----------------------------------------------------------------
    const origin = new URL(url).origin;
    let sitemapFromRobots: string | null = null;
    try {
      const r = await safeFetch(`${origin}/robots.txt`, { policy: ctx.policy, timeoutMs: 10_000, maxBytes: 256 * 1024, signal: ctx.signal });
      if (r.status === 200 && !/<html/i.test(r.body ?? '')) {
        const body = r.body ?? '';
        sitemapFromRobots = /^\s*sitemap:\s*(\S+)/im.exec(body)?.[1] ?? null;
        if (/^\s*disallow:\s*\/\s*$/im.test(body) && /^\s*user-agent:\s*\*/im.test(body)) fix('robots_txt', 'robots.txt', 'warning', 'high', 'robots.txt disallows the whole site for all crawlers.', 'Remove "Disallow: /" before launch if the site should be searchable.');
        else out.push(ok('robots_txt', 'robots.txt', 'robots.txt is present and does not block the site.', `${origin}/robots.txt`));
      } else fix('robots_txt', 'robots.txt', 'warning', 'low', `No robots.txt found (HTTP ${r.status}).`, 'Add a robots.txt that references your sitemap.');
    } catch {
      out.push({ checkKey: 'robots_txt', title: 'robots.txt', status: 'blocked', message: 'robots.txt could not be fetched.', affectedUrl: `${origin}/robots.txt` });
    }
    try {
      const sm = sitemapFromRobots ?? `${origin}/sitemap.xml`;
      const r = await safeFetch(sm, { policy: ctx.policy, timeoutMs: 10_000, maxBytes: 1024 * 1024, signal: ctx.signal });
      if (r.status === 200 && /<(urlset|sitemapindex)[\s>]/i.test(r.body ?? '')) out.push(ok('sitemap', 'XML sitemap', 'A valid XML sitemap was found.', sm));
      else fix('sitemap', 'XML sitemap', 'warning', 'low', `No valid sitemap found at ${sm} (HTTP ${r.status}).`, 'Publish a sitemap.xml and reference it in robots.txt.');
    } catch {
      out.push({ checkKey: 'sitemap', title: 'XML sitemap', status: 'blocked', message: 'The sitemap could not be fetched.' });
    }

    return { status: 'completed', outcomes: out };
  },
};
