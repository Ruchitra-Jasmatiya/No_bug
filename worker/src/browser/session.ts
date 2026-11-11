import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { startGuardedProxy, type BlockedEvent, type GuardedProxy, type NetPolicy } from '@nba/shared/net';

export class BrowserUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BrowserUnavailableError';
  }
}

const SYSTEM_CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export interface BrowserSessionOptions {
  policy: NetPolicy;
  executablePath?: string;
  noSandbox?: boolean;
}

export interface ContextOptions {
  viewport?: { width: number; height: number };
  userAgent?: string;
  isMobile?: boolean;
  hasTouch?: boolean;
  deviceScaleFactor?: number;
  allowServiceWorkers?: boolean;
}

export const BOT_USER_AGENT_SUFFIX = 'NoBugsAllowedBot/1.0';

/**
 * One isolated Chromium instance per test job.
 *  - all traffic is forced through the guarded proxy (connection-time SSRF validation, port allow-list)
 *  - no permissions are ever granted (camera, microphone, location, notifications, clipboard)
 *  - downloads are refused
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private proxy: GuardedProxy | null = null;
  private starting: Promise<void> | null = null;
  version = '';
  executable = '';

  constructor(private readonly options: BrowserSessionOptions) {}

  /** Requests the browser attempted to non-public destinations, refused by the guarded proxy. */
  get blockedByPolicy(): readonly BlockedEvent[] {
    return this.proxy?.blocked ?? [];
  }

  /** Guarded proxy address, for tools (Lighthouse) that launch their own Chrome and must stay behind the SSRF guard. */
  get proxyServer(): string | null {
    return this.proxy?.url ?? null;
  }

  get executablePath(): string {
    return this.executable;
  }

  get isStarted(): boolean {
    return this.browser !== null;
  }

  async start(): Promise<void> {
    if (this.browser) return;
    this.starting ??= this.doStart().catch((err) => {
      this.starting = null;
      throw err;
    });
    await this.starting;
  }

  private resolveExecutable(): string {
    if (this.options.executablePath) {
      if (!existsSync(this.options.executablePath)) {
        throw new BrowserUnavailableError(`Configured browser executable was not found: ${this.options.executablePath}`);
      }
      return this.options.executablePath;
    }
    try {
      const bundled = chromium.executablePath();
      if (bundled && existsSync(bundled)) return bundled;
    } catch {
      /* fall through to system browsers */
    }
    const system = SYSTEM_CHROME_CANDIDATES.find((p) => existsSync(p));
    if (system) return system;
    throw new BrowserUnavailableError(
      'No Chromium browser is installed on the testing worker. Run "npx playwright install --with-deps chromium" or set CHROME_EXECUTABLE_PATH.',
    );
  }

  private async doStart(): Promise<void> {
    const executablePath = this.resolveExecutable();
    this.proxy = await startGuardedProxy({ policy: this.options.policy });
    try {
      const noSandbox = this.options.noSandbox ?? (typeof process.getuid === 'function' && process.getuid() === 0);
      this.browser = await chromium.launch({
        executablePath,
        headless: true,
        proxy: { server: this.proxy.url },
        args: [
          '--proxy-bypass-list=<-loopback>', // force loopback through the proxy too, so the guard sees it
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-sync',
          '--mute-audio',
          ...(noSandbox ? ['--no-sandbox'] : []),
        ],
        timeout: 30_000,
      });
      this.version = this.browser.version();
      this.executable = executablePath;
    } catch (err) {
      await this.proxy.close().catch(() => undefined);
      this.proxy = null;
      throw new BrowserUnavailableError(`The browser could not be launched: ${(err as Error).message.split('\n')[0]}`, { cause: err });
    }
  }

  async newContext(options: ContextOptions = {}): Promise<BrowserContext> {
    await this.start();
    if (!this.browser) throw new BrowserUnavailableError('Browser is not running.');
    return this.browser.newContext({
      viewport: options.viewport ?? { width: 1440, height: 900 },
      userAgent: options.userAgent,
      isMobile: options.isMobile,
      hasTouch: options.hasTouch,
      deviceScaleFactor: options.deviceScaleFactor,
      acceptDownloads: false,
      serviceWorkers: options.allowServiceWorkers ? 'allow' : 'block',
      permissions: [], // never grant camera, microphone, geolocation, notifications or clipboard
      ignoreHTTPSErrors: false,
      locale: 'en-US',
    });
  }

  async close(): Promise<void> {
    const browser = this.browser;
    const proxy = this.proxy;
    this.browser = null;
    this.proxy = null;
    this.starting = null;
    await browser?.close().catch(() => undefined);
    await proxy?.close().catch(() => undefined);
  }
}
