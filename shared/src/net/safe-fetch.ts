import { Agent, fetch as undiciFetch } from 'undici';
import { LIMITS } from '../constants.js';
import { normalizeTargetUrl } from '../url.js';
import { type NetPolicy, STRICT_POLICY } from './ip.js';
import { BlockedTargetError, createGuardedLookup, resolvePublicAddresses, type Resolver, systemResolver } from './resolve.js';

export type SafeFetchErrorCode =
  | 'blocked'
  | 'invalid_url'
  | 'dns'
  | 'timeout'
  | 'refused'
  | 'tls'
  | 'too_many_redirects'
  | 'redirect_loop'
  | 'network';

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SafeFetchError';
  }
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Set false to skip reading the body (status and headers only). */
  readBody?: boolean;
  policy?: NetPolicy;
  /** Injectable DNS resolver, used by tests. */
  resolver?: Resolver;
  signal?: AbortSignal;
}

export interface RedirectHop {
  from: string;
  to: string;
  status: number;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  requestedUrl: string;
  finalUrl: string;
  redirects: RedirectHop[];
  headers: Record<string, string>;
  setCookies: string[];
  body: string | null;
  bytes: number;
  truncated: boolean;
  timings: { ttfbMs: number; totalMs: number };
}

const USER_AGENT = 'NoBugsAllowedBot/1.0 (+website testing; https://nobugsallowed.example/bot)';

function findCause(err: unknown, predicate: (e: { code?: string; name?: string }) => boolean): unknown {
  let current: unknown = err;
  for (let i = 0; i < 6 && current && typeof current === 'object'; i++) {
    if (predicate(current as { code?: string; name?: string })) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function classifyError(err: unknown, url: string): SafeFetchError {
  if (err instanceof SafeFetchError) return err;

  const blocked = findCause(err, (e) => e.code === 'EBLOCKED' || e.name === 'BlockedTargetError');
  if (blocked) {
    return new SafeFetchError('blocked', 'This address points to a private or internal destination and cannot be tested.', url, { cause: err });
  }
  const timeout = findCause(err, (e) => e.name === 'TimeoutError' || e.name === 'AbortError' || e.code === 'UND_ERR_CONNECT_TIMEOUT' || e.code === 'UND_ERR_HEADERS_TIMEOUT' || e.code === 'ETIMEDOUT');
  if (timeout) return new SafeFetchError('timeout', 'The website took too long to respond.', url, { cause: err });

  const dns = findCause(err, (e) => e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN');
  if (dns) return new SafeFetchError('dns', 'The website address could not be found.', url, { cause: err });

  const refused = findCause(err, (e) => e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH');
  if (refused) return new SafeFetchError('refused', 'The website refused or dropped the connection.', url, { cause: err });

  const tls = findCause(err, (e) => typeof e.code === 'string' && /CERT|SSL|TLS|ERR_TLS/.test(e.code));
  if (tls) return new SafeFetchError('tls', `The website's TLS certificate could not be verified (${(tls as { code?: string }).code}).`, url, { cause: err });

  return new SafeFetchError('network', 'The website could not be reached.', url, { cause: err });
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'set-cookie') out[key.toLowerCase()] = value;
  });
  return out;
}

async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!body) return { text: '', bytes: 0, truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - bytes));
      bytes = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated };
}

/**
 * SSRF-hardened HTTP client.
 *  - validates syntax of the URL at every hop (scheme, credentials, ports, hostnames)
 *  - validates every resolved IP at connection time and connects to the validated address
 *  - follows redirects manually so each hop is re-validated
 *  - caps redirects, time and downloaded bytes
 */
export async function safeFetch(inputUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const policy = options.policy ?? STRICT_POLICY;
  const resolver = options.resolver ?? systemResolver;
  const maxRedirects = options.maxRedirects ?? LIMITS.maxRedirects;
  const timeoutMs = options.timeoutMs ?? LIMITS.connectTimeoutMs;
  const maxBytes = options.maxBytes ?? LIMITS.maxDocumentBytes;
  const method = options.method ?? 'GET';
  const started = Date.now();

  const dispatcher = new Agent({
    connect: { lookup: createGuardedLookup(policy, resolver) as never, timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });

  const redirects: RedirectHop[] = [];
  const visited = new Set<string>();
  let current = inputUrl;

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const check = normalizeTargetUrl(current, { relaxed: policy.allowPrivateTargets });
      if (!check.ok) {
        throw new SafeFetchError(check.code === 'blocked_hostname' || check.code === 'blocked_port' ? 'blocked' : 'invalid_url', check.message, current);
      }
      current = check.url;
      if (visited.has(current)) {
        throw new SafeFetchError('redirect_loop', 'The website redirects in a loop.', current);
      }
      visited.add(current);

      // Pre-flight so IP literals and obviously blocked hosts fail fast with a clear error.
      // The connection-time lookup guard remains the authoritative check.
      try {
        await resolvePublicAddresses(check.hostname, policy, resolver);
      } catch (err) {
        if (err instanceof BlockedTargetError) throw classifyError(err, current);
        throw classifyError(err, current);
      }

      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const hopStart = Date.now();
      let res;
      try {
        res = await undiciFetch(current, {
          method,
          redirect: 'manual',
          dispatcher,
          signal,
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...options.headers },
        });
      } catch (err) {
        throw classifyError(err, current);
      }
      const ttfbMs = Date.now() - hopStart;

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          throw new SafeFetchError('invalid_url', 'The website redirected to an invalid address.', current);
        }
        redirects.push({ from: current, to: next, status: res.status });
        await res.body?.cancel().catch(() => undefined);
        current = next;
        continue;
      }

      let body: string | null = null;
      let bytes = 0;
      let truncated = false;
      if (options.readBody !== false && method !== 'HEAD') {
        try {
          const read = await readLimited(res.body as ReadableStream<Uint8Array> | null, maxBytes);
          body = read.text;
          bytes = read.bytes;
          truncated = read.truncated;
        } catch (err) {
          throw classifyError(err, current);
        }
      } else {
        await res.body?.cancel().catch(() => undefined);
      }

      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        statusText: res.statusText,
        requestedUrl: inputUrl,
        finalUrl: current,
        redirects,
        headers: headersToRecord(res.headers as unknown as Headers),
        setCookies: res.headers.getSetCookie(),
        body,
        bytes,
        truncated,
        timings: { ttfbMs, totalMs: Date.now() - started },
      };
    }
    throw new SafeFetchError('too_many_redirects', `The website redirected more than ${maxRedirects} times.`, current);
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}
