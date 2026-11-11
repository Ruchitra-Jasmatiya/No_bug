import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { stripBrackets } from '../url.js';
import { type NetPolicy, STRICT_POLICY } from './ip.js';
import { BlockedTargetError, resolvePublicAddresses, type Resolver, systemResolver } from './resolve.js';

export interface BlockedEvent {
  host: string;
  port: number;
  reason: string;
  at: string;
}

export interface GuardedProxyOptions {
  policy?: NetPolicy;
  resolver?: Resolver;
  /** Interface to bind. Must stay loopback so only the local browser can use it. */
  host?: string;
  allowedPorts?: ReadonlySet<number>;
  idleTimeoutMs?: number;
  maxConcurrentSockets?: number;
  onBlocked?: (event: BlockedEvent) => void;
}

export interface GuardedProxy {
  port: number;
  url: string;
  blocked: BlockedEvent[];
  close(): Promise<void>;
}

const DEFAULT_PORTS: ReadonlySet<number> = new Set([80, 443, 8080, 8443]);
const HOP_BY_HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/**
 * A tiny forward proxy that Chromium is launched through. Every connection the
 * browser makes (document, subresources, redirects, XHR, WebSocket upgrades via
 * CONNECT) is resolved here, every address is checked against the SSRF policy,
 * and the connection is made to the validated IP directly. That closes the DNS
 * rebinding window that request-interception alone cannot.
 */
export async function startGuardedProxy(options: GuardedProxyOptions = {}): Promise<GuardedProxy> {
  const policy = options.policy ?? STRICT_POLICY;
  const resolver = options.resolver ?? systemResolver;
  const allowedPorts = options.allowedPorts ?? DEFAULT_PORTS;
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
  const maxSockets = options.maxConcurrentSockets ?? 256;
  const blocked: BlockedEvent[] = [];
  const open = new Set<Duplex>();

  const recordBlocked = (host: string, port: number, reason: string): void => {
    const event: BlockedEvent = { host, port, reason, at: new Date().toISOString() };
    if (blocked.length < 200) blocked.push(event);
    options.onBlocked?.(event);
  };

  async function validate(hostRaw: string, port: number): Promise<{ address: string; family: 4 | 6 }> {
    const host = stripBrackets(hostRaw);
    if (!policy.allowPrivateTargets && !allowedPorts.has(port)) {
      recordBlocked(host, port, 'port not allowed');
      throw new BlockedTargetError(`Port ${port} is not allowed.`, host);
    }
    if (open.size >= maxSockets) throw new Error('proxy at capacity');
    try {
      const addresses = await resolvePublicAddresses(host, policy, resolver);
      return addresses[0]!;
    } catch (err) {
      if (err instanceof BlockedTargetError) recordBlocked(host, port, 'non-public destination');
      throw err;
    }
  }

  function track(socket: Duplex): void {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    if ('setTimeout' in socket && typeof socket.setTimeout === 'function') {
      (socket as net.Socket).setTimeout(idleTimeoutMs, () => socket.destroy());
    }
  }

  const server = http.createServer(async (req, res) => {
    // Plain HTTP proxying: absolute-form request target.
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end('Unsupported protocol');
      return;
    }
    const port = Number(target.port || 80);
    try {
      const dest = await validate(target.hostname, port);
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
      const upstream = http.request(
        { host: dest.address, family: dest.family, port, method: req.method, path: `${target.pathname}${target.search}`, headers, setHost: false },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      track(req.socket);
      upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    } catch (err) {
      res.writeHead(err instanceof BlockedTargetError ? 403 : 502).end(err instanceof BlockedTargetError ? 'Blocked by policy' : 'Bad gateway');
    }
  });

  // HTTPS (and WebSocket) tunnelling.
  server.on('connect', async (req, clientSocket: Duplex, head: Buffer) => {
    const [hostRaw, portRaw] = splitHostPort(req.url ?? '');
    const port = Number(portRaw || 443);
    track(clientSocket);
    try {
      const dest = await validate(hostRaw, port);
      const upstream = net.connect({ host: dest.address, family: dest.family, port }, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      track(upstream);
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    } catch (err) {
      const blockedErr = err instanceof BlockedTargetError;
      clientSocket.write(`HTTP/1.1 ${blockedErr ? '403 Forbidden' : '502 Bad Gateway'}\r\nConnection: close\r\n\r\n`);
      clientSocket.destroy();
    }
  });

  server.on('clientError', (_err, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, options.host ?? '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind guarded proxy');

  return {
    port: address.port,
    url: `http://${options.host ?? '127.0.0.1'}:${address.port}`,
    blocked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function splitHostPort(authority: string): [string, string] {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return [authority.slice(0, end + 1), authority.slice(end + 2)];
  }
  const idx = authority.lastIndexOf(':');
  return idx === -1 ? [authority, ''] : [authority.slice(0, idx), authority.slice(idx + 1)];
}
