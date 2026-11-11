import type { CheckOutcome } from '@nba/shared';
import { resolvePublicAddresses, safeFetch, SafeFetchError } from '@nba/shared/net';
import type { ModuleResult, TestModule } from './types.js';

const FRIENDLY: Record<string, string> = {
  blocked: 'This address points to a private or internal destination and cannot be tested.',
  dns: 'We could not reach this website. Please verify the address and try again.',
  refused: 'We could not reach this website. Please verify the address and try again.',
  timeout: 'The website took too long to respond.',
  tls: "The website's security certificate could not be verified.",
  too_many_redirects: 'The website redirects too many times.',
  redirect_loop: 'The website redirects in a loop.',
  invalid_url: 'Please enter a valid website URL.',
  network: 'We could not reach this website. Please verify the address and try again.',
};

export const connectivityModule: TestModule = {
  id: 'connectivity',
  async run(ctx): Promise<ModuleResult> {
    const outcomes: CheckOutcome[] = [];
    const url = ctx.target.url;

    // DNS ----------------------------------------------------------------------
    let addresses: string[] = [];
    try {
      const resolved = await resolvePublicAddresses(ctx.target.hostname, ctx.policy);
      addresses = resolved.map((a) => a.address);
      outcomes.push({ checkKey: 'dns_resolution', title: 'DNS resolution', status: 'pass', message: `${ctx.target.hostname} resolves to ${addresses.join(', ')}.`, evidence: { addresses } });
    } catch (err) {
      const code = (err as { code?: string }).code;
      const blocked = code === 'EBLOCKED';
      outcomes.push({
        checkKey: 'dns_resolution',
        title: 'DNS resolution',
        status: blocked ? 'blocked' : 'fail',
        severity: 'critical',
        affectedUrl: url,
        message: blocked ? FRIENDLY.blocked! : `The domain ${ctx.target.hostname} could not be resolved (${code ?? 'lookup failed'}).`,
        evidence: { hostname: ctx.target.hostname, code: code ?? null },
        recommendation: blocked ? 'Only publicly reachable websites can be tested.' : 'Check the spelling of the domain and that its DNS records are published and propagated.',
      });
      return { status: 'completed', outcomes, fatal: blocked ? FRIENDLY.blocked : FRIENDLY.dns, checkpoint: { reachable: false } };
    }

    // HTTP ---------------------------------------------------------------------
    try {
      const res = await safeFetch(url, { policy: ctx.policy, timeoutMs: 15_000, maxBytes: 64 * 1024, signal: ctx.signal, readBody: false });
      const finalUrl = res.finalUrl;
      const redirectEvidence = res.redirects.map((r) => ({ from: r.from, to: r.to, status: r.status }));

      outcomes.push({
        checkKey: 'http_reachable',
        title: 'Website responds to HTTP requests',
        status: res.status >= 500 ? 'fail' : res.status >= 400 ? 'warning' : 'pass',
        severity: res.status >= 500 ? 'critical' : 'high',
        confidence: 'confirmed',
        affectedUrl: finalUrl,
        message: res.status >= 400 ? `The server answered ${res.status} ${res.statusText}.` : `The server answered ${res.status} in ${res.timings.totalMs} ms.`,
        evidence: { status: res.status, statusText: res.statusText, totalMs: res.timings.totalMs, ttfbMs: res.timings.ttfbMs, redirects: redirectEvidence, server: res.headers['server'] ?? null },
        recommendation:
          res.status >= 500
            ? 'The server returned an error. Check application and server logs for the failing request, fix the cause, and redeploy.'
            : 'Confirm that the address is correct and that the page is publicly accessible without authentication.',
      });

      if (res.redirects.length > 0) {
        outcomes.push({
          checkKey: 'redirect_chain',
          title: 'Redirect chain',
          status: res.redirects.length >= 3 ? 'warning' : 'info',
          severity: res.redirects.length >= 3 ? 'low' : 'informational',
          affectedUrl: url,
          message: `The address redirects ${res.redirects.length} time(s) before the final page (${finalUrl}).`,
          evidence: { hops: redirectEvidence },
          recommendation: 'Link directly to the final URL and avoid chained redirects, which slow down every first visit.',
        });
      }

      const startsHttps = new URL(url).protocol === 'https:';
      const endsHttps = new URL(finalUrl).protocol === 'https:';
      if (!startsHttps && endsHttps) {
        outcomes.push({ checkKey: 'https_upgrade', title: 'HTTP upgrades to HTTPS', status: 'pass', message: 'The plain HTTP address redirects to HTTPS.', affectedUrl: url, evidence: { finalUrl } });
      } else if (!endsHttps) {
        outcomes.push({
          checkKey: 'https_available',
          title: 'Site is served over HTTPS',
          status: 'fail',
          severity: 'high',
          confidence: 'confirmed',
          affectedUrl: finalUrl,
          message: 'The final page is served over plain HTTP, so traffic can be read or modified in transit.',
          evidence: { finalUrl },
          recommendation: 'Install a TLS certificate (for example a free Let\'s Encrypt certificate) and redirect all HTTP traffic to HTTPS.',
        });
      }

      const ct = res.headers['content-type'] ?? '';
      const isHtml = /text\/html|application\/xhtml\+xml/i.test(ct);
      outcomes.push({
        checkKey: 'content_type_html',
        title: 'Address serves an HTML page',
        status: isHtml || res.status >= 400 ? (isHtml ? 'pass' : 'skipped') : 'warning',
        severity: 'medium',
        confidence: 'confirmed',
        affectedUrl: finalUrl,
        message: isHtml ? `Content type is ${ct}.` : res.status >= 400 ? 'Skipped because the server returned an error status.' : `The response is "${ct || 'unknown'}", not an HTML page, so browser-based tests may not apply.`,
        evidence: { contentType: ct },
      });

      const reachable = res.status < 500;
      return {
        status: 'completed',
        outcomes,
        checkpoint: { reachable, status: res.status, finalUrl, isHtml, redirects: res.redirects.length, totalMs: res.timings.totalMs },
        fatal: res.status >= 500 ? `The website returned a server error (${res.status}). Browser tests were not run.` : undefined,
      };
    } catch (err) {
      const e = err instanceof SafeFetchError ? err : null;
      const code = e?.code ?? 'network';
      outcomes.push({
        checkKey: 'http_reachable',
        title: 'Website responds to HTTP requests',
        status: code === 'blocked' ? 'blocked' : 'fail',
        severity: 'critical',
        confidence: 'confirmed',
        affectedUrl: url,
        message: FRIENDLY[code] ?? FRIENDLY.network!,
        evidence: { errorCode: code, detail: e?.message ?? (err as Error).message },
        recommendation: code === 'tls' ? 'Renew or correct the TLS certificate: it must be valid, unexpired, and match the domain, with the full chain served.' : 'Check that the server is running, the address is correct, and no firewall blocks public access.',
      });
      return { status: 'completed', outcomes, fatal: FRIENDLY[code] ?? FRIENDLY.network, checkpoint: { reachable: false, errorCode: code } };
    }
  },
};
