import type { Page } from 'playwright';
import type { CheckOutcome } from '@nba/shared';
import type { ModuleContext, ModuleResult } from '../modules/types.js';
import type { ContextOptions } from './session.js';

export class NavigationFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NavigationFailed';
  }
}

export interface OpenPageOptions extends ContextOptions {
  /** Extra time to let late requests settle after load (ms). */
  settleMs?: number;
  /** Runs before navigation (init scripts, offline mode, ...). */
  beforeNavigate?: (page: Page) => Promise<void>;
  url?: string;
}

/**
 * Open the target in an isolated context, wait for the page to settle, run `fn`, and always clean up.
 * Aborting the module (cancel / timeout / shutdown) closes the context immediately.
 */
export async function withPage<T>(ctx: ModuleContext, opts: OpenPageOptions, fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await ctx.browser();
  const context = await browser.newContext(opts);
  // Bundlers (esbuild keepNames) can inject a __name helper into evaluated functions; make it exist in the page.
  await context.addInitScript('window.__name = window.__name || function (f) { return f; };');
  const page = await context.newPage();
  const onAbort = () => void context.close().catch(() => undefined);
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await opts.beforeNavigate?.(page);
    try {
      await page.goto(opts.url ?? ctx.target.url, { waitUntil: 'domcontentloaded', timeout: ctx.settings.timeouts.navigationMs });
    } catch (err) {
      throw new NavigationFailed(((err as Error).message ?? 'Navigation failed').split('\n')[0]!.slice(0, 300));
    }
    await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 2_500 }).catch(() => undefined);
    if (opts.settleMs) await page.waitForTimeout(opts.settleMs);
    return await fn(page);
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
    await context.close().catch(() => undefined);
  }
}

/** A module whose target could not be loaded is BLOCKED (never passed, never silently skipped). */
export function navigationBlocked(label: string, err: unknown): ModuleResult {
  const reason = err instanceof NavigationFailed ? err.message : `${(err as Error).message ?? err}`.split('\n')[0]!;
  const note = `${label} could not run because the page could not be loaded: ${reason}`;
  return { status: 'blocked', note, error: note, outcomes: [{ checkKey: 'page_loaded', title: 'Page could be loaded for this module', status: 'blocked', message: note }] };
}

/** DOM-based modules do not apply to non-HTML targets (a JSON endpoint, a PDF ...). */
export function skipUnlessHtml(ctx: ModuleContext, label: string): ModuleResult | null {
  const conn = ctx.prior('connectivity')?.checkpoint as { isHtml?: boolean } | undefined;
  if (conn && conn.isHtml === false) {
    return { status: 'skipped', note: `${label} applies to HTML pages; the target is not an HTML document.`, outcomes: [] };
  }
  return null;
}

export const info = (checkKey: string, title: string, message: string, evidence: Record<string, unknown> = {}): CheckOutcome => ({
  checkKey,
  title,
  status: 'info',
  severity: 'informational',
  confidence: 'informational',
  message,
  evidence,
});
