import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { CheckOutcome } from '@nba/shared';
import { navigationBlocked, skipUnlessHtml, withPage } from '../browser/open-page.js';
import type { ModuleResult, TestModule } from './types.js';

const VIEWPORTS = [
  { id: 'mobile', width: 375, height: 812 },
  { id: 'desktop', width: 1440, height: 900 },
];
const MAX_BASELINE_BYTES = 3 * 1024 * 1024;
const CHANGE_THRESHOLD = 0.02; // 2% of pixels

export const visualRegressionModule: TestModule = {
  id: 'visual_regression',
  async run(ctx): Promise<ModuleResult> {
    const skip = skipUnlessHtml(ctx, 'Visual regression');
    if (skip) return skip;
    const out: CheckOutcome[] = [];
    let loaded = 0;
    let lastErr: unknown = null;
    for (const vp of VIEWPORTS) {
      if (ctx.signal.aborted) break;
      try {
        await withPage(ctx, { viewport: { width: vp.width, height: vp.height }, settleMs: 500 }, async (page) => {
          loaded++;
          await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' }).catch(() => undefined);
          const png = await page.screenshot({ type: 'png', fullPage: false });
          const url = ctx.target.url;
          const base = await ctx.store.getBaseline(ctx.job.user_id, url, vp.id);
          if (!base) {
            if (png.byteLength <= MAX_BASELINE_BYTES) await ctx.store.saveBaseline(ctx.job.user_id, ctx.job.id, url, vp.id, vp.width, vp.height, png);
            out.push({ checkKey: `visual_${vp.id}`, title: `Visual baseline (${vp.id}, ${vp.width}px)`, status: 'info', severity: 'informational', confidence: 'informational', affectedUrl: url, message: 'No previous baseline existed, so this screenshot was saved as the baseline. Nothing was compared; run the test again after changes to detect visual differences.', evidence: { baselineCreated: true } });
            return;
          }
          const a = PNG.sync.read(base);
          const b = PNG.sync.read(png);
          if (a.width !== b.width || a.height !== b.height) {
            out.push({ checkKey: `visual_${vp.id}`, title: `Visual comparison (${vp.id})`, status: 'warning', severity: 'low', confidence: 'potential', affectedUrl: url, message: `The screenshot size differs from the baseline (${a.width}×${a.height} vs ${b.width}×${b.height}), so pixels could not be compared.`, evidence: { baseline: [a.width, a.height], current: [b.width, b.height] }, recommendation: 'If the change is intended, delete the baseline to capture a new one.' });
            return;
          }
          const diff = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.1 });
          const ratio = diff / (a.width * a.height);
          const pct = (ratio * 100).toFixed(2);
          out.push(ratio > CHANGE_THRESHOLD
            ? { checkKey: `visual_${vp.id}`, title: `Visual change detected (${vp.id})`, status: 'warning', severity: 'medium', confidence: 'confirmed', affectedUrl: url, message: `${pct}% of pixels differ from the baseline at ${vp.width}px. If this change was intentional, no action is needed.`, evidence: { differingPixels: diff, percent: Number(pct), viewport: vp.id }, recommendation: 'Review the page at this width. If the change is intended, it will be the new reference once the baseline is reset.' }
            : { checkKey: `visual_${vp.id}`, title: `Visual comparison (${vp.id})`, status: 'pass', affectedUrl: url, message: `The page matches the baseline at ${vp.width}px (${pct}% pixel difference).`, evidence: { percent: Number(pct) } });
        });
      } catch (err) {
        lastErr = err;
      }
    }
    if (loaded === 0) return navigationBlocked('Visual regression', lastErr);
    return { status: 'completed', outcomes: out };
  },
};
