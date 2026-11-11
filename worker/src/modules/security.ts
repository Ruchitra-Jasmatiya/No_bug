import type { CheckOutcome } from '@nba/shared';
import { safeFetch } from '@nba/shared/net';
import { fetchFailureOutcome, fetchPage } from '../lib/html.js';
import type { ModuleResult, TestModule } from './types.js';

/** Paths whose exposure is a real problem, each with a content signature so a generic 200 page is not misreported. */
const EXPOSURE_PROBES: Array<{ path: string; label: string; signature: RegExp; severity: 'critical' | 'high' }> = [
  { path: '/.env', label: 'Environment file (.env)', signature: /^\s*[A-Z][A-Z0-9_]{2,}\s*=\s*\S+/m, severity: 'critical' },
  { path: '/.git/HEAD', label: 'Git repository metadata', signature: /^ref:\s*refs\/heads\//, severity: 'critical' },
  { path: '/.git/config', label: 'Git configuration', signature: /\[core\]/, severity: 'critical' },
  { path: '/.DS_Store', label: 'macOS directory metadata (.DS_Store)', signature: /Bud1/, severity: 'high' },
  { path: '/wp-config.php.bak', label: 'WordPress configuration backup', signature: /DB_PASSWORD|DB_NAME/, severity: 'critical' },
  { path: '/phpinfo.php', label: 'phpinfo() page', signature: /PHP Version|phpinfo\(\)/i, severity: 'high' },
  { path: '/server-status', label: 'Apache server-status page', signature: /Apache Server Status/i, severity: 'high' },
];

export const securityModule: TestModule = {
  id: 'security',
  async run(ctx): Promise<ModuleResult> {
    let page;
    try {
      page = await fetchPage(ctx);
    } catch (err) {
      return fetchFailureOutcome('Security checks', err);
    }
    const { res, $, url } = page;
    const h = res.headers;
    const isHttps = new URL(url).protocol === 'https:';
    const out: CheckOutcome[] = [];
    const add = (o: CheckOutcome) => out.push({ affectedUrl: url, ...o });

    // Transport ------------------------------------------------------------------------------
    if (!isHttps) add({ checkKey: 'https', title: 'HTTPS', status: 'fail', severity: 'high', confidence: 'confirmed', message: 'The site is served over plain HTTP; traffic can be read or altered in transit.', recommendation: 'Serve the site over HTTPS and redirect all HTTP traffic to it.' });
    else add({ checkKey: 'https', title: 'HTTPS', status: 'pass', message: 'The page is served over HTTPS.' });

    if (isHttps) {
      try {
        const httpUrl = `http://${new URL(url).host}${new URL(url).pathname}`;
        const r = await safeFetch(httpUrl, { policy: ctx.policy, timeoutMs: 10_000, maxBytes: 4096, readBody: false, maxRedirects: 3, signal: ctx.signal });
        const ends = new URL(r.finalUrl).protocol === 'https:';
        add({ checkKey: 'http_redirect', title: 'HTTP redirects to HTTPS', status: ends ? 'pass' : 'warning', severity: 'medium', confidence: 'confirmed', message: ends ? 'HTTP requests are redirected to HTTPS.' : 'The HTTP version of the site does not redirect to HTTPS.', recommendation: 'Add a permanent redirect from http:// to https://.' });
      } catch {
        add({ checkKey: 'http_redirect', title: 'HTTP redirects to HTTPS', status: 'info', severity: 'informational', confidence: 'informational', message: 'Port 80 is not reachable, so HTTP→HTTPS redirection could not be assessed.' });
      }
      if (!h['strict-transport-security']) add({ checkKey: 'hsts', title: 'HSTS header', status: 'warning', severity: 'medium', confidence: 'confirmed', message: 'No Strict-Transport-Security header.', recommendation: 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains.' });
      else add({ checkKey: 'hsts', title: 'HSTS header', status: 'pass', message: 'Strict-Transport-Security is set.', evidence: { value: h['strict-transport-security'] } });
    }

    // Headers --------------------------------------------------------------------------------
    const csp = h['content-security-policy'];
    if (!csp) add({ checkKey: 'csp', title: 'Content-Security-Policy', status: 'warning', severity: 'medium', confidence: 'confirmed', message: 'No Content-Security-Policy header; the site has no browser-enforced defence against injected scripts.', recommendation: 'Define a Content-Security-Policy that restricts script sources.' });
    else if (/script-src[^;]*'unsafe-inline'/.test(csp) || /default-src[^;]*\*/.test(csp)) add({ checkKey: 'csp', title: 'Content-Security-Policy', status: 'warning', severity: 'low', confidence: 'potential', message: 'The Content-Security-Policy allows inline scripts or wildcard sources, weakening its protection.', evidence: { csp: csp.slice(0, 400) }, recommendation: "Remove 'unsafe-inline' and wildcard sources; use nonces or hashes." });
    else add({ checkKey: 'csp', title: 'Content-Security-Policy', status: 'pass', message: 'A Content-Security-Policy is set.' });

    if (h['x-content-type-options']?.toLowerCase() !== 'nosniff') add({ checkKey: 'nosniff', title: 'X-Content-Type-Options', status: 'warning', severity: 'low', confidence: 'confirmed', message: 'X-Content-Type-Options: nosniff is missing.', recommendation: 'Send X-Content-Type-Options: nosniff.' });
    else add({ checkKey: 'nosniff', title: 'X-Content-Type-Options', status: 'pass', message: 'nosniff is set.' });

    if (!h['x-frame-options'] && !/frame-ancestors/i.test(csp ?? '')) add({ checkKey: 'clickjacking', title: 'Clickjacking protection', status: 'warning', severity: 'medium', confidence: 'confirmed', message: 'Neither X-Frame-Options nor CSP frame-ancestors is set; the page can be embedded in a hostile site.', recommendation: "Send X-Frame-Options: DENY (or SAMEORIGIN) or CSP frame-ancestors 'self'." });
    else add({ checkKey: 'clickjacking', title: 'Clickjacking protection', status: 'pass', message: 'Framing is restricted.' });

    if (!h['referrer-policy']) add({ checkKey: 'referrer_policy', title: 'Referrer-Policy', status: 'warning', severity: 'low', confidence: 'confirmed', message: 'No Referrer-Policy header.', recommendation: 'Send Referrer-Policy: strict-origin-when-cross-origin.' });
    if (!h['permissions-policy']) add({ checkKey: 'permissions_policy', title: 'Permissions-Policy', status: 'info', severity: 'informational', confidence: 'informational', message: 'No Permissions-Policy header (optional hardening for camera, microphone and geolocation).' });

    // Information disclosure -----------------------------------------------------------------
    const server = h['server'] ?? '';
    const powered = h['x-powered-by'] ?? '';
    if (/\d+\.\d+/.test(server) || powered) add({ checkKey: 'version_disclosure', title: 'Technology / version disclosure', status: 'warning', severity: 'low', confidence: 'confirmed', message: `The response reveals software details (${[server && `Server: ${server}`, powered && `X-Powered-By: ${powered}`].filter(Boolean).join(', ')}).`, evidence: { server, powered }, recommendation: 'Remove or genericise Server and X-Powered-By headers.' });

    // CORS -----------------------------------------------------------------------------------
    if (h['access-control-allow-origin'] === '*' && h['access-control-allow-credentials']?.toLowerCase() === 'true') add({ checkKey: 'cors', title: 'CORS configuration', status: 'fail', severity: 'high', confidence: 'confirmed', message: 'The page allows any origin together with credentials.', recommendation: 'Never combine Access-Control-Allow-Origin: * with credentials; allow only specific origins.' });

    // Cookies --------------------------------------------------------------------------------
    for (const c of res.setCookies.slice(0, 10)) {
      const name = c.split('=')[0]!.trim();
      const missing = [isHttps && !/;\s*secure/i.test(c) && 'Secure', !/;\s*httponly/i.test(c) && 'HttpOnly', !/;\s*samesite=/i.test(c) && 'SameSite'].filter(Boolean) as string[];
      const sensitive = /sess|auth|token|jwt|sid/i.test(name);
      if (missing.length) add({ checkKey: `cookie_${name}`.slice(0, 80), title: `Cookie "${name}" flags`, status: 'warning', severity: sensitive ? 'medium' : 'low', confidence: 'confirmed', message: `Cookie "${name}" is missing: ${missing.join(', ')}.`, evidence: { cookie: name, missing }, recommendation: 'Set Secure, HttpOnly and SameSite on cookies, especially session cookies.' });
    }

    // Mixed content & unsafe links -----------------------------------------------------------
    if (isHttps) {
      const mixed = $('script[src],link[rel="stylesheet"][href],img[src],iframe[src]').toArray().map((e) => $(e).attr('src') ?? $(e).attr('href') ?? '').filter((u) => u.startsWith('http://'));
      if (mixed.length) add({ checkKey: 'mixed_content', title: 'Mixed content', status: 'fail', severity: 'high', confidence: 'confirmed', message: `${mixed.length} resource(s) are loaded over insecure HTTP on an HTTPS page.`, evidence: { urls: mixed.slice(0, 10) }, recommendation: 'Load every resource over HTTPS.' });
      else add({ checkKey: 'mixed_content', title: 'Mixed content', status: 'pass', message: 'No insecure resource references found in the HTML.' });
    }
    const unsafeBlank = $('a[target="_blank"]').filter((_, e) => !/noopener|noreferrer/.test($(e).attr('rel') ?? '')).length;
    if (unsafeBlank) add({ checkKey: 'target_blank', title: 'Links opening new tabs', status: 'info', severity: 'informational', confidence: 'informational', message: `${unsafeBlank} link(s) use target="_blank" without rel="noopener" (modern browsers imply it).`, recommendation: 'Add rel="noopener noreferrer".' });
    const pwForm = $('input[type="password"]').closest('form').toArray().filter((f) => isHttps && ($(f).attr('action') ?? '').startsWith('http://'));
    if (pwForm.length) add({ checkKey: 'password_form_http', title: 'Password form posts over HTTP', status: 'fail', severity: 'critical', confidence: 'confirmed', message: 'A password form submits to an insecure HTTP address.', recommendation: 'Submit credentials only over HTTPS.' });

    // Exposed files (passive GETs, signature-verified) ---------------------------------------
    const origin = new URL(url).origin;
    let exposed = 0;
    for (const probe of EXPOSURE_PROBES) {
      if (ctx.signal.aborted) break;
      try {
        const r = await safeFetch(origin + probe.path, { policy: ctx.policy, timeoutMs: 8_000, maxBytes: 8192, maxRedirects: 0, signal: ctx.signal });
        if (r.status === 200 && r.body && probe.signature.test(r.body)) {
          exposed++;
          out.push({ checkKey: `exposed_${probe.path.replace(/\W+/g, '_')}`, title: probe.label, status: 'fail', severity: probe.severity, confidence: 'confirmed', affectedUrl: origin + probe.path, message: `${probe.label} is publicly downloadable at ${probe.path}. Its content matches the expected file signature.`, evidence: { path: probe.path, status: r.status }, recommendation: 'Remove this file from the web root immediately and rotate any secret it may have contained.' });
        }
      } catch {
        /* unreachable path = not exposed */
      }
    }
    if (exposed === 0) out.push({ checkKey: 'exposed_files', title: 'Sensitive files not exposed', status: 'pass', affectedUrl: origin, message: `${EXPOSURE_PROBES.length} common sensitive paths were requested; none returned recognisable sensitive content.`, evidence: { probed: EXPOSURE_PROBES.map((p) => p.path) } });

    out.push({ checkKey: 'scope_note', title: 'Scope of security checks', status: 'info', severity: 'informational', confidence: 'informational', message: 'These are passive, non-destructive checks (headers, cookies, transport, exposed files). They are not a penetration test and cannot prove the site is secure.' });
    return { status: 'completed', outcomes: out };
  },
};
