import { VIEWPORTS, type CheckOutcome } from '@nba/shared';
import { navigationBlocked, skipUnlessHtml, withPage } from '../browser/open-page.js';
import { layoutOutcomes, measureLayout } from './ui.js';
import type { ModuleResult, TestModule } from './types.js';

export const responsiveModule: TestModule = {
  id: 'responsive',
  async run(ctx): Promise<ModuleResult> {
    const skip = skipUnlessHtml(ctx, 'Responsive testing');
    if (skip) return skip;
    const out: CheckOutcome[] = [];
    const perViewport: Array<{ id: string; ok: boolean }> = [];
    let loaded = 0;
    let lastError: unknown = null;
    // All viewports are measured at the same time, each in its own isolated browser context.
    const parts = await Promise.all(
      VIEWPORTS.map(async (vp) => {
        const o: CheckOutcome[] = [];
        if (ctx.signal.aborted) return { o, ok: null as boolean | null };
        const mobile = vp.width < 768;
        try {
          return await withPage(ctx, { viewport: { width: vp.width, height: vp.height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, settleMs: 200 }, async (page) => {
            const f = await page.evaluate(measureLayout);
            loaded++;
            const label = `${vp.label}, ${vp.width}px`;
            o.push(...layoutOutcomes(f, page.url(), label, `${vp.id}_`).filter((x) => !x.checkKey.endsWith('small_text') || mobile));
            // The viewport meta is what makes mobile layouts work at all.
            if (mobile && !(await page.evaluate(() => !!document.querySelector('meta[name="viewport"]')))) {
              o.push({ checkKey: `${vp.id}_no_viewport_meta`, title: `No viewport meta tag (${label})`, status: 'fail', severity: 'high', confidence: 'confirmed', affectedUrl: page.url(), message: 'Without a viewport meta tag, phones render the page at desktop width and shrink it.', recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.' });
            }
            return { o, ok: o.every((x) => x.status !== 'fail') as boolean | null };
          });
        } catch (err) {
          lastError = err;
          o.push({ checkKey: `${vp.id}_load`, title: `Page load at ${vp.label} (${vp.width}px)`, status: 'blocked', message: `Could not load the page at ${vp.width}px: ${((err as Error).message ?? '').split('\n')[0]!.slice(0, 160)}` });
          return { o, ok: null as boolean | null };
        }
      }),
    );
    parts.forEach((p, i) => {
      out.push(...p.o);
      if (p.ok !== null) perViewport.push({ id: VIEWPORTS[i]!.id, ok: p.ok });
    });
    if (loaded === 0) return navigationBlocked('Responsive testing', lastError);
    const clean = perViewport.filter((v) => v.ok).map((v) => v.id);
    if (loaded === VIEWPORTS.length && !out.some((o) => ['fail', 'warning', 'blocked'].includes(o.status))) out.unshift({ checkKey: 'responsive_clean', title: 'Responsive layout', status: 'pass', affectedUrl: ctx.target.url, message: `No layout problems detected at ${loaded} of ${VIEWPORTS.length} screen sizes (320px to 1920px).`, evidence: { viewports: VIEWPORTS.map((v) => v.width) } });
    return { status: 'completed', outcomes: out, checkpoint: { viewportsOk: clean } };
  },
};
