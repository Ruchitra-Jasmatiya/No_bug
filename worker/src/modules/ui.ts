import type { CheckOutcome } from '@nba/shared';
import { navigationBlocked, skipUnlessHtml, withPage } from '../browser/open-page.js';
import type { ModuleResult, TestModule } from './types.js';

export interface LayoutFindings {
  horizontalOverflow: { scrollWidth: number; clientWidth: number } | null;
  overflowingElements: Array<{ selector: string; right: number }>;
  tinyTapTargets: Array<{ selector: string; w: number; h: number }>;
  smallText: number;
  imagesWithoutSize: number;
  brokenImages: Array<{ src: string }>;
  overlaps: Array<{ a: string; b: string }>;
  emptyButtons: number;
  fixedCoverage: number;
}

/** Runs inside the page. Pure DOM measurement; nothing is clicked or modified. */
export function measureLayout(): LayoutFindings {
  const sel = (el: Element) => {
    const e = el as HTMLElement;
    return (el.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '')).slice(0, 80);
  };
  const vw = document.documentElement.clientWidth;
  const sw = document.documentElement.scrollWidth;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const all = Array.from(document.body.querySelectorAll('*')).filter(visible);
  const overflowingElements = all
    .filter((e) => {
      const r = e.getBoundingClientRect();
      if (r.right <= vw + 1) return false;
      // ignore content clipped by an ancestor with overflow hidden/auto/scroll
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'hidden' || o === 'auto' || o === 'scroll' || o === 'clip') return false;
      }
      return getComputedStyle(e).position !== 'fixed';
    })
    .slice(0, 8)
    .map((e) => ({ selector: sel(e), right: Math.round(e.getBoundingClientRect().right) }));
  const tiny = Array.from(document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button]'))
    .filter(visible)
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return (r.width < 24 || r.height < 24) && !(e.tagName === 'A' && getComputedStyle(e).display === 'inline');
    })
    .slice(0, 8)
    .map((e) => ({ selector: sel(e), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) }));
  let smallText = 0;
  for (const e of all) {
    if (e.children.length === 0 && (e.textContent ?? '').trim().length > 3 && parseFloat(getComputedStyle(e).fontSize) < 11) smallText++;
  }
  const imgs = Array.from(document.images).filter(visible);
  const brokenImages = imgs.filter((i) => i.complete && i.naturalWidth === 0).slice(0, 8).map((i) => ({ src: i.currentSrc || i.src }));
  const imagesWithoutSize = imgs.filter((i) => !i.getAttribute('width') && !i.getAttribute('height') && !i.style.width && !i.style.height && !i.getAttribute('style')?.includes('aspect-ratio')).length;
  // Overlapping text-bearing blocks (siblings only, to avoid flagging intended layering)
  const overlaps: Array<{ a: string; b: string }> = [];
  const blocks = all.filter((e) => e.children.length === 0 && (e.textContent ?? '').trim().length > 1 && getComputedStyle(e).position !== 'absolute' && getComputedStyle(e).position !== 'fixed').slice(0, 150);
  for (let i = 0; i < blocks.length && overlaps.length < 5; i++) {
    const a = blocks[i]!.getBoundingClientRect();
    for (let j = i + 1; j < blocks.length; j++) {
      const bEl = blocks[j]!;
      if (blocks[i]!.contains(bEl) || bEl.contains(blocks[i]!)) continue;
      const b = bEl.getBoundingClientRect();
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix > 6 && iy > 6 && (ix * iy) / Math.min(a.width * a.height, b.width * b.height) > 0.3) {
        overlaps.push({ a: sel(blocks[i]!), b: sel(bEl) });
        break;
      }
    }
  }
  const emptyButtons = Array.from(document.querySelectorAll('button,[role=button]')).filter(visible).filter((b) => !(b.textContent ?? '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title') && !b.querySelector('img[alt],svg title')).length;
  const fixedCoverage = all.filter((e) => getComputedStyle(e).position === 'fixed').reduce((m, e) => { const r = e.getBoundingClientRect(); return Math.max(m, (r.width * r.height) / (innerWidth * innerHeight)); }, 0);
  return { horizontalOverflow: sw > vw + 1 ? { scrollWidth: sw, clientWidth: vw } : null, overflowingElements, tinyTapTargets: tiny, smallText, imagesWithoutSize, brokenImages, overlaps, emptyButtons, fixedCoverage: Math.round(fixedCoverage * 100) / 100 };
}

export function layoutOutcomes(f: LayoutFindings, url: string, vpLabel: string, keyPrefix: string): CheckOutcome[] {
  const out: CheckOutcome[] = [];
  const at = ` (${vpLabel})`;
  const add = (o: CheckOutcome) => out.push({ affectedUrl: url, confidence: 'confirmed', ...o });
  if (f.horizontalOverflow) add({ checkKey: `${keyPrefix}horizontal_overflow`, title: `Horizontal scrolling${at}`, status: 'fail', severity: 'high', message: `Content is ${f.horizontalOverflow.scrollWidth}px wide in a ${f.horizontalOverflow.clientWidth}px viewport${at}, so visitors must scroll sideways.`, evidence: { ...f.horizontalOverflow, elements: f.overflowingElements }, recommendation: 'Find the elements wider than the viewport (listed in the evidence) and give them max-width: 100%, wrapping or responsive sizing.' });
  if (f.brokenImages.length) add({ checkKey: `${keyPrefix}broken_images`, title: `Broken images${at}`, status: 'fail', severity: 'medium', message: `${f.brokenImages.length} visible image(s) failed to render${at}.`, evidence: { images: f.brokenImages }, recommendation: 'Fix the image URLs or restore the missing files.' });
  if (f.overlaps.length) add({ checkKey: `${keyPrefix}overlap`, title: `Overlapping content${at}`, status: 'warning', severity: 'medium', confidence: 'potential', message: `${f.overlaps.length} pair(s) of text elements overlap${at}.`, evidence: { pairs: f.overlaps }, recommendation: 'Check spacing, line-height and fixed heights around these elements.' });
  if (f.tinyTapTargets.length) add({ checkKey: `${keyPrefix}tap_targets`, title: `Small interactive targets${at}`, status: 'warning', severity: 'low', message: `${f.tinyTapTargets.length} control(s) are smaller than 24×24 px${at}.`, evidence: { targets: f.tinyTapTargets }, recommendation: 'Make touch targets at least 24×24 px (44×44 px recommended on mobile).' });
  if (f.smallText) add({ checkKey: `${keyPrefix}small_text`, title: `Very small text${at}`, status: 'warning', severity: 'low', message: `${f.smallText} text element(s) use a font size under 11px${at}.`, recommendation: 'Use at least 12px for body text.' });
  if (f.emptyButtons) add({ checkKey: `${keyPrefix}empty_buttons`, title: `Buttons without a label${at}`, status: 'fail', severity: 'medium', message: `${f.emptyButtons} button(s) have no text or accessible name${at}.`, recommendation: 'Add visible text or an aria-label.' });
  return out;
}

export const uiModule: TestModule = {
  id: 'ui',
  async run(ctx): Promise<ModuleResult> {
    const skip = skipUnlessHtml(ctx, 'UI testing');
    if (skip) return skip;
    try {
      return await withPage(ctx, { viewport: { width: 1440, height: 900 }, settleMs: 300 }, async (page) => {
        // Layout shift observed over the settle window.
        const cls = await page.evaluate(() => new Promise<number>((resolve) => {
          let total = 0;
          try {
            new PerformanceObserver((l) => { for (const e of l.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) total += e.value; }).observe({ type: 'layout-shift', buffered: true });
          } catch { resolve(-1); return; }
          setTimeout(() => resolve(total), 400);
        }));
        const f = await page.evaluate(measureLayout);
        const out = layoutOutcomes(f, page.url(), 'desktop 1440px', 'ui_');
        if (cls > 0.25) out.push({ checkKey: 'ui_layout_shift', title: 'Layout shift during load', status: 'warning', severity: 'medium', confidence: 'confirmed', affectedUrl: page.url(), message: `Content shifted unexpectedly while loading (cumulative layout shift ${cls.toFixed(2)}).`, evidence: { cls }, recommendation: 'Reserve space for images, ads and late-loading content with width/height or aspect-ratio.' });
        if (f.imagesWithoutSize > 3) out.push({ checkKey: 'ui_image_dimensions', title: 'Images without dimensions', status: 'warning', severity: 'low', confidence: 'confirmed', affectedUrl: page.url(), message: `${f.imagesWithoutSize} images have no width/height, which causes layout shift while they load.`, recommendation: 'Add width and height attributes (or CSS aspect-ratio).' });
        if (f.fixedCoverage > 0.6) out.push({ checkKey: 'ui_fixed_cover', title: 'Fixed element covers most of the screen', status: 'warning', severity: 'medium', confidence: 'potential', affectedUrl: page.url(), message: 'A fixed-position element covers more than 60% of the viewport, which may block content (for example a cookie banner or modal).', recommendation: 'Make sure overlays can be dismissed and do not hide primary content.' });
        if (out.length === 0) out.push({ checkKey: 'ui_clean', title: 'Layout checks', status: 'pass', affectedUrl: page.url(), message: 'No overflow, overlapping text, broken images, undersized controls or unlabelled buttons were detected at 1440px.' });
        return { status: 'completed' as const, outcomes: out };
      });
    } catch (err) {
      return navigationBlocked('UI testing', err);
    }
  },
};
