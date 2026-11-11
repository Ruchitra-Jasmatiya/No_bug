/**
 * Browser end-to-end: the BUILT web app in real Chrome, talking to the real API, a real worker process,
 * Redis and PostgreSQL. Drives sign-up -> email code -> login -> live test -> refresh protection -> report.
 *   npm run build -w web   (first)
 *   TEST_DATABASE_URL=... TEST_REDIS_URL=... CHROME_EXECUTABLE_PATH=/usr/bin/google-chrome npm run test:e2e
 * Skipped (never "passed") when prerequisites are missing.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { Redis } from 'ioredis';
import pg from 'pg';
import { createApp } from '../api/src/app.js';
import { createLogger } from '../api/src/lib/logger.js';
import { createJobQueue } from '../api/src/queue/queue.js';
import { MemoryTransport } from '../api/src/email/transports.js';
import { testApiConfig } from '../api/test/helpers.js';
import { startFixtureSite } from '../worker/test/helpers.js';

const DB = process.env.TEST_DATABASE_URL;
const REDIS = process.env.TEST_REDIS_URL;
const CHROME = process.env.CHROME_EXECUTABLE_PATH;
const DIST = path.resolve(import.meta.dirname, '../web/dist');
const ready = Boolean(DB && REDIS && CHROME && fs.existsSync(path.join(DIST, 'index.html')));
const suite = ready ? describe : describe.skip;
const SHOTS = process.env.SHOT_DIR ?? '';
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

suite('browser end-to-end (built web app)', { timeout: 600_000 }, () => {
  const pool = new pg.Pool({ connectionString: DB, max: 6 });
  const mail = new MemoryTransport();
  let site: Awaited<ReturnType<typeof startFixtureSite>>;
  let apiServer: http.Server;
  let webServer: http.Server;
  let webBase = '';
  let worker: ChildProcess;
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  const email = `e2e+${Date.now()}@example.com`;
  const password = 'Sunflower-Lantern-42';
  const pageErrors: string[] = [];

  before(async () => {
    await pool.query('delete from public.auth_attempts'); // per-IP throttles persist across runs on a shared test DB
    site = await startFixtureSite();
    const { app } = createApp({
      config: testApiConfig({ REDIS_URL: REDIS!, CORS_ORIGINS: 'http://localhost', corsOrigins: ['http://localhost'], databaseUrl: DB! }),
      pool, queue: createJobQueue(REDIS!), logger: createLogger('silent'), policy: { allowPrivateTargets: true }, emailTransport: mail,
    });
    apiServer = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const apiPort = (apiServer.address() as AddressInfo).port;

    // Static server for web/dist with an /api proxy, exactly what Vercel's rewrites do in production.
    webServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
        const p = http.request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: req.headers }, (u) => { res.writeHead(u.statusCode ?? 502, u.headers); u.pipe(res); });
        p.on('error', () => res.writeHead(502).end());
        req.pipe(p);
        return;
      }
      let file = path.join(DIST, path.normalize(url.pathname));
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise<void>((r) => webServer.listen(0, '127.0.0.1', () => r()));
    webBase = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;

    worker = spawn(process.execPath, ['--import', 'tsx', 'worker/src/main.ts'], {
      cwd: path.resolve(import.meta.dirname, '..'), detached: true, stdio: 'ignore',
      env: { ...process.env, NODE_ENV: 'test', NBA_ALLOW_PRIVATE_TARGETS: 'true', SUPABASE_DB_URL: DB, REDIS_URL: REDIS, WORKER_ID: 'e2e-browser', LOG_LEVEL: 'silent', WORKER_CONCURRENCY: '1', CHROME_EXECUTABLE_PATH: CHROME },
    });
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
    page = await ctx.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
  });

  after(async () => {
    await browser?.close().catch(() => undefined);
    if (worker?.pid) { try { process.kill(-worker.pid, 'SIGKILL'); } catch { /* gone */ } }
    webServer?.close(); apiServer?.close(); await site?.close();
    // Leave no half-finished queue jobs behind for the next suite (TEST_REDIS_URL is a dedicated test Redis).
    await new Promise((r) => setTimeout(r, 500));
    const r = new Redis(REDIS!); await r.flushdb(); r.disconnect();
    await pool.end();
    process.exit(0); // BullMQ connections created by the API keep the loop alive
  });

  const shot = async (name: string) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); };

  it('home page renders with the required hero text and a working URL box', async () => {
    await page.goto(webBase + '/');
    await page.getByRole('heading', { name: 'Your Website Deserves a Bug-Free Experience.' }).waitFor();
    assert.ok(await page.getByPlaceholder('Enter your website URL (https://example.com)').isVisible());
    assert.ok(await page.getByRole('button', { name: /Start Testing/ }).isVisible());
    await shot('home-desktop');
    await page.locator('#how').scrollIntoViewIfNeeded();
    await page.locator('.step').first().waitFor({ state: 'visible' });
    assert.equal(await page.locator('.step').count(), 4);
  });

  it('signed-out Start Testing sends the visitor to sign up (URL remembered)', async () => {
    await page.getByPlaceholder('Enter your website URL (https://example.com)').fill(site.base + '/buggy');
    await page.getByLabel(/I own this website/).check();
    await page.getByRole('button', { name: /Start Testing/ }).click();
    await page.waitForURL('**/signup');
  });

  it('sign-up validates, then emails a real code and verifies it', async () => {
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByText('Please enter your full name.').waitFor();
    await page.getByLabel('Full name').fill('Eddie Tester');
    await page.getByLabel('Email').fill(email);
    await page.locator('#password').fill('short');
    await page.locator('#confirmPassword').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByText(/at least 8 characters/i).first().waitFor();
    await page.locator('#password').fill(password);
    await page.locator('#confirmPassword').fill(password);
    await page.getByText(/Strength:/).waitFor();
    await shot('signup');
    await page.getByLabel(/I agree to the/).check();
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL('**/verify-email');
    // wrong code first
    for (let i = 0; i < 6; i++) await page.getByLabel(`Digit ${i + 1}`).fill('0');
    await page.getByRole('button', { name: /Verify email/ }).click();
    await page.getByText(/incorrect/i).waitFor();
    await shot('verify-otp');
    const code = mail.codeFor(email);
    await page.getByLabel('Digit 1').click();
    await page.keyboard.insertText(code); // paste-style entry across the boxes
    await page.getByRole('button', { name: /Verify email/ }).click();
    await page.waitForURL('**/login');
    await page.getByText('Email verified. Please log in.').first().waitFor();
  });

  it('login rejects a wrong password, accepts the right one, and shows the dashboard', async () => {
    await page.locator('#login-password').fill('Wrong-Password-1');
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.getByText('Incorrect email or password.').first().waitFor();
    await page.locator('#login-password').fill(password);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForURL('**/dashboard');
    await page.getByRole('heading', { name: /ready to squash some bugs/ }).waitFor();
    await shot('dashboard-empty');
  });

  it('a session survives a page reload (silent refresh from the HttpOnly cookie)', async () => {
    await page.reload();
    await page.getByRole('heading', { name: /ready to squash some bugs/ }).waitFor();
    const cookies = await ctx.cookies();
    const rt = cookies.find((c) => c.name === 'nba_rt');
    assert.ok(rt?.httpOnly, 'refresh cookie must be HttpOnly');
    const ls = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    assert.ok(!/eyJ/.test(ls), 'no access token in web storage');
  });

  let jobId = '';
  it('starting a test shows live progress, survives going offline, and guards refresh', async () => {
    await page.getByPlaceholder('Enter your website URL (https://example.com)').fill(site.base + '/buggy');
    await page.getByLabel(/I own this website/).check();
    await page.getByRole('button', { name: /Start Testing/ }).click();
    await page.waitForURL(/\/tests\/[0-9a-f-]{36}$/);
    jobId = page.url().split('/').pop()!;
    await page.getByRole('progressbar').waitFor();
    await page.getByText('What’s being tested').waitFor();

    // network loss: banner appears, then clears when the connection returns; progress is not lost
    await ctx.setOffline(true);
    await page.getByText('Connection interrupted. Your test progress is saved. Reconnecting…').waitFor({ timeout: 20_000 });
    await shot('test-offline');
    await ctx.setOffline(false);
    await page.getByText('Connection interrupted.').waitFor({ state: 'detached', timeout: 30_000 });

    // F5 is intercepted by the confirmation modal
    await page.keyboard.press('F5');
    const dlg = page.getByRole('dialog', { name: 'Your test is still running' });
    await dlg.waitFor();
    for (const n of ['Continue Testing', 'Start Again', 'Stay Here']) assert.ok(await dlg.getByRole('button', { name: n }).isVisible(), n);
    await shot('refresh-modal');
    await dlg.getByRole('button', { name: 'Stay Here' }).click();
    await dlg.waitFor({ state: 'detached' });
    assert.ok(page.url().endsWith(jobId));

    // Continue Testing reloads and the same test is still there with its progress
    await page.keyboard.press('F5');
    await page.getByRole('dialog').getByRole('button', { name: 'Continue Testing' }).click();
    await page.waitForURL(`**/tests/${jobId}`);
    await page.getByRole('progressbar').waitFor();
    await shot('test-running');
  });

  it('navigating away shows the running test banner and it can be reopened', async () => {
    await page.goto(webBase + '/dashboard');
    await page.getByText(/is (running|waiting to start)/).first().waitFor();
    await page.getByRole('link', { name: 'Continue watching' }).first().click();
    await page.waitForURL(`**/tests/${jobId}`);
  });

  it('the finished test opens a report with real findings', async () => {
    await page.waitForURL(`**/reports/${jobId}`, { timeout: 420_000 });
    await page.getByRole('heading', { name: /Issues \(/ }).waitFor();
    assert.ok(!(await page.getByText('No issues detected in the tests performed.').first().isVisible().catch(() => false)), 'buggy fixture must produce issues');
    const first = page.locator('.issue-head').first();
    await first.click();
    await page.getByText('Recommended fix').first().waitFor();
    await shot('report-desktop');
    await page.getByRole('button', { name: 'Copy fix' }).first().click();
    await page.getByText('Fix copied to clipboard.').waitFor();
    // severity filter narrows the list
    const total = await page.locator('.issue').count();
    const chip = page.locator('[aria-label="Filter by severity"] .chip').nth(1);
    await chip.click();
    assert.ok((await page.locator('.issue').count()) <= total);
  });

  it('PDF download works', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF' }).click()]);
    const file = await dl.path();
    assert.ok(file && fs.statSync(file).size > 1500);
    assert.equal(fs.readFileSync(file).subarray(0, 4).toString(), '%PDF');
  });

  it('BUGSY opens and states honestly that AI is not configured', async () => {
    await page.getByRole('button', { name: 'Ask BUGSY' }).first().click();
    await page.getByRole('region', { name: 'BUGSY chat' }).waitFor();
    await page.getByText(/AI is not switched on for this server/).waitFor();
    await shot('bugsy-unconfigured');
    await page.getByRole('button', { name: 'Close chat' }).click();
  });

  it('dashboard lists the finished test; a non-admin cannot open /admin', async () => {
    await page.goto(webBase + '/dashboard');
    await page.getByRole('link', { name: 'Open report' }).first().waitFor();
    await shot('dashboard');
    await page.goto(webBase + '/admin');
    await page.waitForURL('**/dashboard');
  });

  it('mobile layout: no horizontal scroll and a working hamburger menu', async () => {
    const m = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true });
    const mp = await m.newPage();
    await mp.goto(webBase + '/');
    await mp.getByRole('heading', { name: 'Your Website Deserves a Bug-Free Experience.' }).waitFor();
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
    await mp.getByRole('button', { name: 'Menu' }).click();
    await mp.getByRole('link', { name: 'Create account' }).last().waitFor();
    if (SHOTS) await mp.screenshot({ path: path.join(SHOTS, 'home-mobile-menu.png') });
    await mp.getByRole('button', { name: 'Menu' }).click();
    for (const p of ['/signup', '/login', '/about', '/terms', '/privacy', '/contact']) {
      await mp.goto(webBase + p);
      const o = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(o <= 1, `${p} overflows by ${o}px`);
    }
    if (SHOTS) { await mp.goto(webBase + '/'); await mp.screenshot({ path: path.join(SHOTS, 'home-mobile.png'), fullPage: true }); }
    await m.close();
  });

  it('logout clears the session', async () => {
    await page.goto(webBase + '/dashboard');
    await page.getByRole('heading', { name: /ready to squash some bugs/ }).waitFor({ timeout: 15_000 }).catch(async () => { await shot('logout-debug'); throw new Error('dashboard did not load before logout: ' + page.url()); });
    await page.getByRole('button', { name: /Log out/ }).first().click();
    await page.waitForURL(webBase + '/');
    await page.goto(webBase + '/dashboard');
    await page.waitForURL('**/login');
  });

  it('no uncaught page errors occurred', () => {
    assert.deepEqual(pageErrors, []);
  });
});
