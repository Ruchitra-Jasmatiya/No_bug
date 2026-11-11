import { BrowserUnavailableError } from '../browser/session.js';
import type { ModuleResult, TestModule } from './types.js';

export const browserLaunchModule: TestModule = {
  id: 'browser_launch',
  async run(ctx): Promise<ModuleResult> {
    try {
      const browser = await ctx.browser();
      return {
        status: 'completed',
        outcomes: [
          {
            checkKey: 'browser_launch',
            title: 'Isolated browser session started',
            status: 'pass',
            message: `Chromium ${browser.version} started in an isolated, permission-free session.`,
            evidence: { version: browser.version },
          },
        ],
        checkpoint: { version: browser.version },
      };
    } catch (err) {
      // Infrastructure problem, not a problem with the user's website: never counted as a pass or a site bug.
      const message = err instanceof BrowserUnavailableError ? err.message : `The browser could not be launched: ${(err as Error).message}`;
      return {
        status: 'blocked',
        note: 'Browser-based tests could not run on the testing worker.',
        error: message,
        outcomes: [{ checkKey: 'browser_launch', title: 'Isolated browser session started', status: 'blocked', message, evidence: {} }],
        fatal: 'The testing browser could not be started, so browser-based modules were not run.',
      };
    }
  },
};
