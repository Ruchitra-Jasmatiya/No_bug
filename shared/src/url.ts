import { LIMITS } from './constants.js';

export type UrlRejectionCode =
  | 'empty'
  | 'too_long'
  | 'invalid'
  | 'unsupported_scheme'
  | 'credentials_in_url'
  | 'blocked_hostname'
  | 'blocked_port';

export type UrlCheck =
  | { ok: true; url: string; hostname: string; origin: string }
  | { ok: false; code: UrlRejectionCode; message: string };

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet', '.corp'];
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

export const INVALID_URL_MESSAGE = 'Please enter a valid website URL.';

/** Strip brackets from an IPv6 literal hostname as returned by WHATWG URL. */
export function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Syntax-level validation and normalisation of a user supplied target URL.
 * This is the first line of defence only. The authoritative check is the
 * connection-time IP validation in `@nba/shared/net`, which also covers DNS
 * rebinding and redirects.
 */
export function normalizeTargetUrl(input: string, opts: { relaxed?: boolean } = {}): UrlCheck {
  const relaxed = opts.relaxed === true;
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, code: 'empty', message: INVALID_URL_MESSAGE };
  if (raw.length > LIMITS.maxUrlLength) return { ok: false, code: 'too_long', message: INVALID_URL_MESSAGE };

  // Reject non-http schemes explicitly (javascript:, file:, ftp:, data: ...).
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  if (schemeMatch && !hasExplicitScheme && !/^[^/?#]*:\d+(\/|$|\?|#)/.test(raw)) {
    return { ok: false, code: 'unsupported_scheme', message: 'Only http and https website addresses can be tested.' };
  }

  const withScheme = hasExplicitScheme ? raw : `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, code: 'invalid', message: INVALID_URL_MESSAGE };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: 'unsupported_scheme', message: 'Only http and https website addresses can be tested.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, code: 'credentials_in_url', message: 'Website addresses containing a username or password are not allowed.' };
  }

  const hostname = stripBrackets(parsed.hostname).toLowerCase().replace(/\.$/, '');
  if (!hostname) return { ok: false, code: 'invalid', message: INVALID_URL_MESSAGE };

  if (!relaxed && (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s)))) {
    return { ok: false, code: 'blocked_hostname', message: 'This address points to a private or internal destination and cannot be tested.' };
  }

  // Single-label names (e.g. "intranet", "db") are never public websites.
  const isIpLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  if (!relaxed && !isIpLiteral && !hostname.includes('.')) {
    return { ok: false, code: 'invalid', message: INVALID_URL_MESSAGE };
  }

  if (!relaxed && !ALLOWED_PORTS.has(parsed.port)) {
    return { ok: false, code: 'blocked_port', message: 'Only websites served on standard web ports (80, 443, 8080, 8443) can be tested.' };
  }

  parsed.hash = '';
  return { ok: true, url: parsed.toString(), hostname, origin: parsed.origin };
}
