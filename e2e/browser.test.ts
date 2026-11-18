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
  // Codes go to WhatsApp. This fake provider records what would be sent, exactly like a real one would deliver it.
  const waCodes = new Map<string, string>();
  const whatsapp = { name: 'meta' as const, async sendOtp(to: string, code: string) { waCodes.set(to, code); return { providerId: 'e2e' }; } };
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
      pool, queue: createJobQueue(REDIS!), logger: createLogger('silent'), policy: { allowPrivateTargets: true }, emailTransport: mail, whatsapp,
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

  it('a signed-out visitor lands on the login page first, with a way to sign up', async () => {
    await page.goto(webBase + '/');
    await page.waitForURL('**/login');
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
    await shot('login');
    await page.getByRole('link', { name: 'Create an account' }).click();
    await page.waitForURL('**/signup');
  });

  it('sign-up validates, sends a code to WhatsApp (not email), and verifies it', async () => {
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByText('Please enter your full name.').waitFor();
    await page.getByText(/WhatsApp number with the country code/).waitFor();
    await page.getByLabel('Full name').fill('Eddie Tester');
    await page.getByLabel('Email').fill(email);
    await page.locator('#phone').fill('+91 98765 43210');
    await page.locator('#whatsapp').fill('+91 98765 43211');
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
    await page.getByText(/WhatsApp number \+91/).waitFor();
    assert.equal(mail.sent.filter((m) => m.to === email).length, 0, 'no email code may be sent');
    // wrong code first
    for (let i = 0; i < 6; i++) await page.getByLabel(`Digit ${i + 1}`).fill('0');
    await page.getByRole('button', { name: /Verify number/ }).click();
    await page.getByText(/incorrect/i).waitFor();
    await shot('verify-otp');
    const code = waCodes.get('+919876543211')!;
    assert.match(code, /^\d{6}$/);
    await page.getByLabel('Digit 1').click();
    await page.keyboard.insertText(code); // paste-style entry across the boxes
    await page.getByRole('button', { name: /Verify number/ }).click();
    await page.waitForURL('**/login');
    await page.getByText('WhatsApp number verified. Please log in.').first().waitFor();
  });

  it('repeated wrong passwords show attempts left, then pause login for a minute', async () => {
    await page.goto(webBase + '/login');
    await page.locator('#login-email').fill('someone-else@example.com');
    for (let i = 1; i <= 4; i++) {
      await page.locator('#login-password').fill('Wrong-Password-' + i);
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.getByText(new RegExp(`You have ${5 - i} attempts? left`)).waitFor();
    }
    await shot('login-attempts-left');
    await page.locator('#login-password').fill('Wrong-Password-5');
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.getByText(/Too many wrong attempts/).waitFor();
    assert.ok(await page.getByRole('button', { name: /Wait \d+s/ }).isDisabled(), 'the button is disabled while paused');
    await shot('login-locked');
    await page.goto(webBase + '/login'); // a fresh page for the real user; the lock above belongs to the other address
    await page.locator('#login-email').fill(email);
  });

  it('login rejects a wrong password, accepts the right one, and shows the dashboard', async () => {
    await page.locator('#login-password').fill('Wrong-Password-1');
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.getByText('Incorrect email, phone number or password.').first().waitFor();
    await page.locator('#login-password').fill(password);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForURL('**/dashboard');
    await page.getByRole('heading', { name: /ready to squash some bugs/ }).waitFor();
    await shot('dashboard-empty');
    // profile menu in the nav bar
    await page.getByRole('button', { name: /Eddie Tester/ }).click();
    await page.getByText('+919876543211').waitFor();
    await shot('profile-menu');
    await page.keyboard.press('Escape');
  });

  it('the signed-in home page shows the hero text and a working URL box', async () => {
    await page.goto(webBase + '/');
    await page.getByRole('heading', { name: 'Your Website Deserves a Bug-Free Experience.' }).waitFor();
    assert.ok(await page.getByPlaceholder('Enter your website URL (https://example.com)').isVisible());
    assert.ok(await page.getByRole('button', { name: /Start Testing/ }).isVisible());
    await shot('home-desktop');
    await page.locator('#how').scrollIntoViewIfNeeded();
    await page.locator('.step').first().waitFor({ state: 'visible' });
    assert.equal(await page.locator('.step').count(), 4);
    await page.goto(webBase + '/dashboard');
    await page.getByRole('heading', { name: /ready to squash some bugs/ }).waitFor();
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
    await page.getByRole('heading', { name: 'Tests performed' }).waitFor();
    await page.getByRole('button', { name: 'Pagination testing' }).waitFor();
    await page.getByRole('button', { name: 'Site pages & URL validation' }).waitFor();

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

  it('BUGSY has a visible Send button and answers from the stored evidence without an AI key', async () => {
    await page.getByRole('button', { name: 'Ask BUGSY' }).first().click();
    const chat = page.getByRole('region', { name: 'BUGSY chat' });
    await chat.waitFor();
    const input = chat.getByLabel('Message BUGSY');
    const send = chat.getByRole('button', { name: /Send/ });
    // The report's own "Ask BUGSY" sends a summary question first; wait for that answer, then the input is free.
    await chat.getByText(/Summary for|Fix in this order|issue/).first().waitFor({ timeout: 20_000 });
    await input.waitFor();
    await page.waitForFunction(() => !(document.querySelector('textarea[aria-label="Message BUGSY"]') as HTMLTextAreaElement | null)?.disabled, null, { timeout: 20_000 });
    assert.ok(await input.isEnabled(), 'input must be enabled');
    assert.ok(await send.isVisible(), 'Send button must be visible');
    assert.ok(await send.isDisabled(), 'Send is disabled until something is typed');
    await input.fill('What should I fix first?');
    await send.click();
    await chat.getByText(/Fix in this order/).first().waitFor({ timeout: 20_000 });
    await shot('bugsy-answer');
    await chat.getByRole('button', { name: 'Close chat' }).click();
  });

  it('dashboard lists the finished test; a non-admin cannot open /admin', async () => {
    await page.goto(webBase + '/dashboard');
    await page.getByRole('link', { name: 'Open report' }).first().waitFor();
    await shot('dashboard');
    await page.goto(webBase + '/admin');
    await page.waitForURL('**/dashboard');
  });

  it('an admin sees every /admin tab with real data', async () => {
    const uid = (await pool.query(`select id from public.profiles where email = $1`, [email])).rows[0].id;
    await pool.query(`insert into public.user_roles (user_id, role) values ($1, 'admin') on conflict do nothing`, [uid]);
    try {
      await page.goto(webBase + '/login');
      await page.waitForURL('**/dashboard').catch(() => undefined);
      await page.reload();
      await page.goto(webBase + '/admin');
      await page.getByRole('tab', { name: 'Overview' }).waitFor();
      for (const tab of ['Overview', 'Users', 'Tests', 'Security', 'Audit log', 'Emails', 'Settings', 'System']) {
        await page.getByRole('tab', { name: tab }).click();
        await page.waitForTimeout(700);
        await shot(`admin-${tab.toLowerCase().replace(' ', '-')}`);
      }
      await page.getByRole('tab', { name: 'Users' }).click();
      await page.getByText(email).first().waitFor();
    } finally {
      await pool.query(`delete from public.user_roles where user_id = $1 and role = 'admin'`, [uid]);
    }
  });

  it('mobile layout: no horizontal scroll and a working hamburger menu', async () => {
    const m = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true });
    const mp = await m.newPage();
    await mp.goto(webBase + '/');
    await mp.waitForURL('**/login');
    await mp.getByRole('heading', { name: 'Welcome back' }).waitFor();
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
    if (SHOTS) { await mp.goto(webBase + '/signup'); await mp.screenshot({ path: path.join(SHOTS, 'signup-mobile.png'), fullPage: true }); }
    await m.close();
  });

  it('logout clears the session', async () => {
    await page.goto(webBase + '/dashboard');
    await page.getByRole('heading', { name: /ready to squash some bugs/ }).waitFor({ timeout: 15_000 }).catch(async () => { await shot('logout-debug'); throw new Error('dashboard did not load before logout: ' + page.url()); });
    await page.getByRole('button', { name: /Eddie Tester/ }).click();
    await page.getByRole('menuitem', { name: /Log out/ }).click();
    await page.waitForURL('**/login');
    await page.goto(webBase + '/dashboard');
    await page.waitForURL('**/login');
  });

  it('no uncaught page errors occurred', () => {
    assert.deepEqual(pageErrors, []);
  });
});
