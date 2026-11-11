import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { CheckOutcome, Severity } from '@nba/shared';
import { navigationBlocked, skipUnlessHtml, withPage } from '../browser/open-page.js';
import type { ModuleResult, TestModule } from './types.js';

const require_ = createRequire(import.meta.url);
let axeSource: string | null = null;
function loadAxe(): string {
  axeSource ??= readFileSync(require_.resolve('axe-core/axe.min.js'), 'utf8');
  return axeSource;
}

const IMPACT: Record<string, Severity> = { critical: 'critical', serious: 'high', moderate: 'medium', minor: 'low' };

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  description: string;
  nodes: Array<{ target: unknown[]; html: string; failureSummary?: string }>;
}

export const accessibilityModule: TestModule = {
  id: 'accessibility',
  async run(ctx): Promise<ModuleResult> {
    const skip = skipUnlessHtml(ctx, 'Accessibility testing');
    if (skip) return skip;
    try {
      return await withPage(ctx, { settleMs: 300 }, async (page) => {
        await page.evaluate(loadAxe()); // CDP evaluate is not subject to the page's Content-Security-Policy
        const axe = (await page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = await (globalThis as any).axe.run(document, { resultTypes: ['violations', 'incomplete'] });
          return { violations: r.violations, incomplete: r.incomplete.length, passes: r.passes?.length ?? 0 };
        })) as { violations: AxeViolation[]; incomplete: number; passes: number };

        const out: CheckOutcome[] = [];
        for (const v of axe.violations.slice(0, 25)) {
          const sev = IMPACT[v.impact ?? 'minor'] ?? 'low';
          out.push({
            checkKey: `axe_${v.id}`,
            title: v.help,
            status: sev === 'low' ? 'warning' : 'fail',
            severity: sev,
            confidence: 'confirmed',
            affectedUrl: page.url(),
            message: `${v.help} — ${v.nodes.length} element(s) affected.`,
            evidence: { rule: v.id, helpUrl: v.helpUrl, description: v.description, elements: v.nodes.slice(0, 5).map((n) => ({ selector: n.target.join(' '), html: n.html.slice(0, 200), summary: n.failureSummary?.slice(0, 300) })) },
            recommendation: `${v.description}. See ${v.helpUrl}`,
          });
        }
        if (axe.violations.length === 0) out.push({ checkKey: 'axe_clean', title: 'Automated accessibility rules (axe-core)', status: 'pass', affectedUrl: page.url(), message: `axe-core found no violations across ${axe.passes} rule(s). Automated tools detect only a portion of accessibility problems.` });
        if (axe.incomplete > 0) out.push({ checkKey: 'axe_incomplete', title: 'Rules needing manual review', status: 'info', severity: 'informational', confidence: 'informational', message: `${axe.incomplete} rule(s) could not be decided automatically (for example colour contrast over images) and need manual review.` });

        // Keyboard & focus ---------------------------------------------------------------------
        const kb = await page.evaluate(async () => {
          const visible = (el: Element) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          };
          const interactive = Array.from(document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[tabindex]')).filter(visible);
          const positiveTabindex = interactive.filter((e) => Number(e.getAttribute('tabindex')) > 0).length;
          const clickableDivs = Array.from(document.querySelectorAll('div[onclick],span[onclick]')).filter((e) => !e.getAttribute('role') && e.getAttribute('tabindex') === null).length;
          return { interactive: interactive.length, positiveTabindex, clickableDivs, hasSkipLink: !!document.querySelector('a[href^="#"]:first-of-type'), hasMain: !!document.querySelector('main,[role=main]') };
        });
        if (kb.positiveTabindex) out.push({ checkKey: 'positive_tabindex', title: 'Positive tabindex values', status: 'warning', severity: 'medium', confidence: 'confirmed', affectedUrl: page.url(), message: `${kb.positiveTabindex} element(s) use tabindex greater than 0, which disrupts natural tab order.`, recommendation: 'Use tabindex="0" or reorder the DOM instead.' });
        if (kb.clickableDivs) out.push({ checkKey: 'clickable_non_interactive', title: 'Click handlers on non-interactive elements', status: 'fail', severity: 'high', confidence: 'confirmed', affectedUrl: page.url(), message: `${kb.clickableDivs} <div>/<span> element(s) have click handlers but cannot be reached with the keyboard.`, recommendation: 'Use <button>/<a>, or add role, tabindex="0" and key handlers.' });

        // Tab through the page: does focus move and is it visible?
        const maxTabs = Math.min(kb.interactive, 25);
        let focusable = 0;
        let invisibleFocus = 0;
        const seen = new Set<string>();
        for (let i = 0; i < maxTabs; i++) {
          await page.keyboard.press('Tab');
          const f = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            if (!el || el === document.body) return null;
            const s = getComputedStyle(el);
            const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
            const shadow = s.boxShadow !== 'none';
            return { id: el.tagName + '|' + (el.id || el.textContent?.slice(0, 20) || ''), visible: outline || shadow };
          });
          if (!f) continue;
          if (!seen.has(f.id)) { seen.add(f.id); focusable++; if (!f.visible) invisibleFocus++; }
        }
        if (kb.interactive > 0 && focusable === 0) out.push({ checkKey: 'keyboard_nav', title: 'Keyboard navigation', status: 'fail', severity: 'high', confidence: 'confirmed', affectedUrl: page.url(), message: 'Pressing Tab never moved focus onto any element.', recommendation: 'Ensure interactive elements are focusable and nothing traps or blocks focus.' });
        else if (kb.interactive > 0 && invisibleFocus > focusable / 2) out.push({ checkKey: 'focus_visible', title: 'Visible focus indicator', status: 'warning', severity: 'medium', confidence: 'potential', affectedUrl: page.url(), message: `${invisibleFocus} of ${focusable} focused element(s) showed no outline or shadow, so keyboard users may not see where they are.`, recommendation: 'Do not remove outlines without providing an equally visible :focus-visible style.' });
        else if (kb.interactive > 0) out.push({ checkKey: 'keyboard_nav', title: 'Keyboard navigation', status: 'pass', affectedUrl: page.url(), message: `Tab moved focus through ${focusable} distinct element(s) with a visible focus indicator.` });
        if (!kb.hasMain) out.push({ checkKey: 'main_landmark', title: 'Main landmark', status: 'warning', severity: 'low', confidence: 'confirmed', affectedUrl: page.url(), message: 'The page has no <main> landmark.', recommendation: 'Wrap the primary content in <main>.' });
        return { status: 'completed' as const, outcomes: out };
      });
    } catch (err) {
      return navigationBlocked('Accessibility testing', err);
    }
  },
};
