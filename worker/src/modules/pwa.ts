import type { CheckOutcome } from '@nba/shared';
import { safeFetch } from '@nba/shared/net';
import { fetchFailureOutcome, fetchPage, resolveUrl } from '../lib/html.js';
import { skipUnlessHtml, withPage, navigationBlocked } from '../browser/open-page.js';
import type { ModuleResult, TestModule } from './types.js';

export const pwaModule: TestModule = {
  id: 'pwa',
  async run(ctx): Promise<ModuleResult> {
    const skip = skipUnlessHtml(ctx, 'PWA testing');
    if (skip) return skip;
    let page;
    try {
      page = await fetchPage(ctx);
    } catch (err) {
      return fetchFailureOutcome('PWA testing', err);
    }
    const { $, url } = page;
    const out: CheckOutcome[] = [];
    const manifestHref = $('link[rel="manifest"]').attr('href');
        if (!manifestHref) {
      out.push({ checkKey: 'manifest', title: 'Web app manifest', status: 'info', severity: 'informational', confidence: 'informational', affectedUrl: url, message: 'No web app manifest is linked. This is only a problem if the site is meant to be installable.' });
    } else {
      const mu = resolveUrl(manifestHref, url)!.href;
      try {
        const r = await safeFetch(mu, { policy: ctx.policy, timeoutMs: 10_000, maxBytes: 256 * 1024, signal: ctx.signal });
        let m: Record<string, unknown> | null = null;
        try { m = JSON.parse(r.body ?? ''); } catch { /* invalid */ }
        if (r.status !== 200 || !m) {
          out.push({ checkKey: 'manifest', title: 'Web app manifest', status: 'fail', severity: 'medium', confidence: 'confirmed', affectedUrl: mu, message: `The manifest could not be loaded as valid JSON (HTTP ${r.status}).`, recommendation: 'Serve a valid manifest.webmanifest with Content-Type application/manifest+json.' });
        } else {
          const missing = ['name', 'start_url', 'display', 'icons'].filter((k) => !m![k]);
          const icons = Array.isArray(m.icons) ? (m.icons as Array<{ sizes?: string }>) : [];
          const has512 = icons.some((i) => /512x512/.test(i.sizes ?? ''));
          const has192 = icons.some((i) => /192x192/.test(i.sizes ?? ''));
          if (missing.length || !has192 || !has512) out.push({ checkKey: 'manifest', title: 'Web app manifest', status: 'warning', severity: 'medium', confidence: 'confirmed', affectedUrl: mu, message: `The manifest is incomplete${missing.length ? `: missing ${missing.join(', ')}` : ''}${!has192 || !has512 ? '; 192x192 and 512x512 icons are required for installability' : ''}.`, evidence: { missing, has192, has512 }, recommendation: 'Add name, start_url, display and 192/512 px icons to the manifest.' });
          else { out.push({ checkKey: 'manifest', title: 'Web app manifest', status: 'pass', affectedUrl: mu, message: 'The manifest is valid and contains the fields required for installability.' }); }
        }
      } catch (err) {
        out.push({ checkKey: 'manifest', title: 'Web app manifest', status: 'blocked', affectedUrl: mu, message: `The manifest could not be fetched: ${(err as Error).message.slice(0, 120)}` });
      }
    }

    if (!$('meta[name="theme-color"]').attr('content')) out.push({ checkKey: 'theme_color', title: 'Theme colour', status: 'info', severity: 'informational', confidence: 'informational', message: 'No theme-color meta tag.' });

    // Service worker: Chromium only, observed with service workers allowed.
    try {
      const sw = await withPage(ctx, { allowServiceWorkers: true, settleMs: 800 }, async (p) =>
        p.evaluate(async () => {
          if (!('serviceWorker' in navigator)) return { supported: false, registered: false, scope: null as string | null };
          const regs = await navigator.serviceWorker.getRegistrations();
          return { supported: true, registered: regs.length > 0, scope: regs[0]?.scope ?? null };
        }),
      );
      out.push(sw.registered
        ? { checkKey: 'service_worker', title: 'Service worker', status: 'pass', affectedUrl: url, message: `A service worker is registered (scope ${sw.scope}).` }
        : { checkKey: 'service_worker', title: 'Service worker', status: 'info', severity: 'informational', confidence: 'informational', affectedUrl: url, message: 'No service worker was registered during page load; offline support and installability are not available.' });
    } catch (err) {
      out.push(...navigationBlocked('The service-worker check', err).outcomes);
    }
    out.push({ checkKey: 'pwa_scope', title: 'Scope of PWA and compatibility checks', status: 'info', severity: 'informational', confidence: 'informational', message: `Checked in Chromium only. Safari and Firefox behaviour was not tested.` });
    return { status: 'completed', outcomes: out };
  },
};
