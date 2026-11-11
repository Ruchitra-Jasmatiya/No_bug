import type { CheckOutcome } from '@nba/shared';
import { safeFetch } from '@nba/shared/net';
import { fetchPage, resolveUrl } from '../lib/html.js';
import { navigationBlocked, skipUnlessHtml, withPage } from '../browser/open-page.js';
import type { ModuleResult, TestModule } from './types.js';

const UNSAFE_LABEL = /delete|remove|destroy|buy|purchase|pay|checkout|order|submit|send|subscribe|sign.?out|log.?out|confirm|unsubscribe|cancel (my|order|subscription)|reset|clear|erase|publish|post/i;

/** Browser features that need a user permission. The tester never grants them, so they are reported as blocked, never as passed. */
const PERMISSION_SIGNATURES: Array<{ key: string; label: string; test: RegExp }> = [
  { key: 'camera_microphone', label: 'Camera / microphone', test: /getUserMedia|mediaDevices\s*\.\s*getUserMedia|MediaRecorder/ },
  { key: 'geolocation', label: 'Location', test: /navigator\s*\.\s*geolocation|getCurrentPosition|watchPosition/ },
  { key: 'notifications', label: 'Notifications', test: /Notification\s*\.\s*requestPermission|pushManager\s*\.\s*subscribe/ },
  { key: 'clipboard', label: 'Clipboard', test: /navigator\s*\.\s*clipboard\s*\.\s*(read|writeText|write)/ },
  { key: 'screen_capture', label: 'Screen capture', test: /getDisplayMedia/ },
];

export const functionalModule: TestModule = {
  id: 'functional',
  async run(ctx): Promise<ModuleResult> {
    const skip = skipUnlessHtml(ctx, 'Functional testing');
    if (skip) return skip;
    const out: CheckOutcome[] = [];

    // 1. Permission-dependent features (source scan; nothing is granted or invoked) ----------------
    try {
      const { $, url, res } = await fetchPage(ctx);
      let source = ($.html() ?? '') + ' ' + $('script:not([src])').text();
      const scripts = $('script[src]').toArray().map((e) => resolveUrl($(e).attr('src'), url)).filter((u): u is URL => !!u && u.origin === new URL(url).origin).slice(0, 8);
      for (const s of scripts) {
        try {
          source += ' ' + ((await safeFetch(s.href, { policy: ctx.policy, timeoutMs: 8_000, maxBytes: 1024 * 1024, signal: ctx.signal })).body ?? '');
        } catch { /* a missing script is reported by other modules */ }
      }
      const found = PERMISSION_SIGNATURES.filter((p) => p.test.test(source));
      for (const p of found) {
        out.push({ checkKey: `permission_${p.key}`, title: `${p.label} features`, status: 'blocked', severity: 'informational', confidence: 'informational', affectedUrl: url, message: `The page appears to use ${p.label.toLowerCase()}. Testing never grants this permission, so this functionality was not tested and is NOT counted as passed. Test it manually with a real device.`, evidence: { feature: p.key, method: 'source scan (static)' } });
      }
      const fileInputs = $('input[type="file"]').length;
      if (fileInputs) out.push({ checkKey: 'permission_file_upload', title: 'File upload fields', status: 'blocked', severity: 'informational', confidence: 'informational', affectedUrl: url, message: `${fileInputs} file upload field(s) found. Uploading files is not performed by the tester, so upload behaviour was not tested.`, evidence: { count: fileInputs } });
      void res;
    } catch (err) {
      out.push({ checkKey: 'permission_scan', title: 'Permission feature scan', status: 'blocked', message: `Could not scan for permission-dependent features: ${((err as Error).message ?? '').split('\n')[0]!.slice(0, 160)}` });
    }

    // 2. Interactive behaviour in a real browser --------------------------------------------------
    try {
      return await withPage(ctx, { settleMs: 300 }, async (page) => {
        const origin = new URL(page.url()).origin;
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
        page.on('dialog', (d) => void d.dismiss().catch(() => undefined));
        page.on('popup', (p) => void p.close().catch(() => undefined));
        const startUrl = page.url();

        // Forms: inspected, never submitted.
        const forms = await page.evaluate(() => Array.from(document.forms).slice(0, 10).map((f) => {
          const fields = Array.from(f.elements).filter((e) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName) && (e as HTMLInputElement).type !== 'hidden' && (e as HTMLInputElement).type !== 'submit' && (e as HTMLInputElement).type !== 'button') as HTMLInputElement[];
          const unlabeled = fields.filter((e) => !e.labels?.length && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && !e.getAttribute('title')).length;
          const hasSubmit = !!f.querySelector('button:not([type=button]):not([type=reset]),input[type=submit]');
          const emailNoType = fields.filter((e) => /email/i.test(e.name + e.id) && e.type !== 'email').length;
          const pwNoAutocomplete = fields.filter((e) => e.type === 'password' && !e.getAttribute('autocomplete')).length;
          return { fields: fields.length, unlabeled, hasSubmit, emailNoType, pwNoAutocomplete, id: f.id || f.getAttribute('name') || f.getAttribute('action') || 'form' };
        }));
        for (const f of forms) {
          if (f.fields > 0 && !f.hasSubmit) out.push({ checkKey: `form_no_submit_${f.id}`.slice(0, 80), title: 'Form without a submit button', status: 'fail', severity: 'medium', confidence: 'confirmed', affectedUrl: startUrl, message: `Form "${f.id}" has ${f.fields} field(s) but no submit button, so keyboard and mobile users cannot send it.`, recommendation: 'Add a <button type="submit">.' });
          if (f.unlabeled) out.push({ checkKey: `form_labels_${f.id}`.slice(0, 80), title: 'Form fields without labels', status: 'fail', severity: 'medium', confidence: 'confirmed', affectedUrl: startUrl, message: `Form "${f.id}" has ${f.unlabeled} field(s) without a label.`, recommendation: 'Associate each field with a <label for=…> or aria-label.' });
          if (f.emailNoType) out.push({ checkKey: `form_email_type_${f.id}`.slice(0, 80), title: 'Email field without type="email"', status: 'warning', severity: 'low', confidence: 'confirmed', affectedUrl: startUrl, message: `Form "${f.id}" has an email field that is not type="email" (mobile keyboards and validation will not help).`, recommendation: 'Use <input type="email">.' });
        }
        if (forms.length) out.push({ checkKey: 'forms_not_submitted', title: 'Form submission', status: 'info', severity: 'informational', confidence: 'informational', affectedUrl: startUrl, message: `${forms.length} form(s) were inspected for structure only. Forms are never submitted, because that could create real records or send real messages.` });

        // Safe interactive elements -------------------------------------------------------------
        const buttons = await page.$$eval('button:not([type=submit]):not([disabled]),[role=button]:not([disabled])', (els) =>
          els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('form'); }).slice(0, 12).map((e, i) => ({ i, text: ((e.textContent ?? '') + ' ' + (e.getAttribute('aria-label') ?? '')).trim().slice(0, 50) })),
        );
        let clicked = 0;
        let skippedUnsafe = 0;
        const clickErrors: Array<{ button: string; error: string }> = [];
        for (const b of buttons) {
          if (ctx.signal.aborted) break;
          if (UNSAFE_LABEL.test(b.text)) { skippedUnsafe++; continue; }
          const before = errors.length;
          try {
            const handle = (await page.$$('button:not([type=submit]):not([disabled]),[role=button]:not([disabled])')).filter(Boolean);
            const target = handle[b.i];
            if (!target) continue;
            await target.click({ timeout: 2_500, trial: false });
            clicked++;
            await page.waitForTimeout(150);
            if (errors.length > before) clickErrors.push({ button: b.text || '(unnamed button)', error: errors[errors.length - 1]! });
            if (page.url() !== startUrl) await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => undefined);
          } catch { /* element detached or covered: not an app error */ }
        }
        for (const c of clickErrors) out.push({ checkKey: `click_error_${Buffer.from(c.button).toString('base64url').slice(0, 30)}`, title: 'JavaScript error when clicking a button', status: 'fail', severity: 'high', confidence: 'confirmed', affectedUrl: startUrl, message: `Clicking "${c.button}" raised an error: ${c.error}`, evidence: c, recommendation: 'Reproduce by clicking the button with the DevTools console open and fix the failing handler.' });
        if (clicked > 0 && clickErrors.length === 0) out.push({ checkKey: 'buttons_clickable', title: 'Buttons respond without errors', status: 'pass', affectedUrl: startUrl, message: `${clicked} safe button(s) were clicked and raised no JavaScript errors.`, evidence: { clicked } });
        if (skippedUnsafe) out.push({ checkKey: 'unsafe_buttons_skipped', title: 'Buttons not clicked', status: 'info', severity: 'informational', confidence: 'informational', affectedUrl: startUrl, message: `${skippedUnsafe} button(s) with labels like delete, buy, submit or log out were not clicked, to avoid real side effects.` });

        // Tabs -----------------------------------------------------------------------------------
        const tabs = await page.$$('[role=tab]');
        if (tabs.length > 1) {
          let broken = 0;
          for (const t of tabs.slice(0, 6)) {
            await t.click({ timeout: 2_000 }).catch(() => undefined);
            if ((await t.getAttribute('aria-selected')) !== 'true') broken++;
          }
          out.push(broken ? { checkKey: 'tabs_state', title: 'Tabs update their selected state', status: 'fail', severity: 'medium', confidence: 'confirmed', affectedUrl: startUrl, message: `${broken} tab(s) did not become aria-selected="true" after being clicked.`, recommendation: 'Update aria-selected and the visible panel when a tab is activated.' } : { checkKey: 'tabs_state', title: 'Tabs update their selected state', status: 'pass', affectedUrl: startUrl, message: 'Tabs switched correctly when clicked.' });
        }

        // Navigation links: same-origin internal links must resolve within the page's own site ----
        const nav = await page.$$eval('nav a[href], header a[href]', (as) => as.slice(0, 15).map((a) => (a as HTMLAnchorElement).href));
        const internal = [...new Set(nav.filter((h) => h.startsWith(origin) && !h.includes('#')))].slice(0, 6);
        let navBroken = 0;
        const navBad: Array<{ url: string; status: number }> = [];
        for (const h of internal) {
          try {
            const r = await page.goto(h, { waitUntil: 'domcontentloaded', timeout: 12_000 });
            if (r && r.status() >= 400) { navBroken++; navBad.push({ url: h, status: r.status() }); }
          } catch { navBroken++; navBad.push({ url: h, status: 0 }); }
        }
        if (internal.length) {
          out.push(navBroken ? { checkKey: 'navigation', title: 'Navigation menu links', status: 'fail', severity: 'high', confidence: 'confirmed', affectedUrl: navBad[0]!.url, message: `${navBroken} of ${internal.length} navigation link(s) lead to an error page.`, evidence: { broken: navBad }, recommendation: 'Fix or remove the broken navigation destinations.' } : { checkKey: 'navigation', title: 'Navigation menu links', status: 'pass', affectedUrl: startUrl, message: `${internal.length} navigation link(s) opened successfully.` });
        }
        if (out.filter((o) => o.status !== 'blocked' && o.status !== 'info').length === 0) {
          out.push({ checkKey: 'functional_nothing_to_test', title: 'Interactive elements', status: 'info', severity: 'informational', confidence: 'informational', affectedUrl: startUrl, message: 'No safe interactive elements (buttons, tabs, navigation links) were found to exercise on this page.' });
        }
        return { status: 'completed' as const, outcomes: out };
      });
    } catch (err) {
      const b = navigationBlocked('Functional testing', err);
      return out.length ? { status: 'completed', outcomes: [...out, ...b.outcomes], note: b.note } : b;
    }
  },
};
