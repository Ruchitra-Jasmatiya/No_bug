import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { safeFetch, SafeFetchError } from '../src/net/safe-fetch.js';
import { startGuardedProxy } from '../src/net/guarded-proxy.js';
import type { NetPolicy } from '../src/net/ip.js';

const DEV: NetPolicy = { allowPrivateTargets: true };
const STRICT: NetPolicy = { allowPrivateTargets: false };

let server: http.Server;
let base: string;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    switch (url.pathname) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['a=1; Secure; HttpOnly', 'b=2'] });
        res.end('<html><title>Hello</title></html>');
        break;
      case '/redir':
        res.writeHead(302, { location: '/ok' }).end();
        break;
      case '/to-metadata':
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
        break;
      case '/loop-a':
        res.writeHead(302, { location: '/loop-b' }).end();
        break;
      case '/loop-b':
        res.writeHead(302, { location: '/loop-a' }).end();
        break;
      case '/chain': {
        const n = Number(url.searchParams.get('n') ?? '0');
        res.writeHead(302, { location: `/chain?n=${n + 1}` }).end();
        break;
      }
      case '/big':
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('x'.repeat(2_000_000));
        break;
      case '/slow':
        setTimeout(() => res.end('late'), 3000);
        break;
      default:
        res.writeHead(404).end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe('safeFetch', () => {
  it('fetches a page and returns status, headers, cookies and body (dev policy)', async () => {
    const r = await safeFetch(`${base}/ok`, { policy: DEV });
    assert.equal(r.status, 200);
    assert.equal(r.ok, true);
    assert.match(r.body ?? '', /<title>Hello<\/title>/);
    assert.equal(r.headers['content-type'], 'text/html');
    assert.equal(r.setCookies.length, 2);
    assert.ok(r.timings.totalMs >= 0);
  });

  it('records a redirect chain', async () => {
    const r = await safeFetch(`${base}/redir`, { policy: DEV });
    assert.equal(r.redirects.length, 1);
    assert.equal(r.finalUrl, `${base}/ok`);
  });

  it('returns non-2xx responses without throwing', async () => {
    const r = await safeFetch(`${base}/missing`, { policy: DEV });
    assert.equal(r.status, 404);
    assert.equal(r.ok, false);
  });

  it('blocks loopback targets under the strict (production) policy', async () => {
    await assert.rejects(safeFetch(`${base}/ok`, { policy: STRICT }), (e: unknown) => e instanceof SafeFetchError && e.code === 'blocked');
  });

  it('blocks an IP-literal private destination', async () => {
    await assert.rejects(safeFetch('http://10.0.0.5/', { policy: STRICT }), (e: unknown) => e instanceof SafeFetchError && e.code === 'blocked');
  });

  it('blocks a redirect to the cloud metadata endpoint, even in dev mode', async () => {
    await assert.rejects(safeFetch(`${base}/to-metadata`, { policy: DEV }), (e: unknown) => e instanceof SafeFetchError && e.code === 'blocked');
  });

  it('blocks a hostname that resolves to a private address', async () => {
    const resolver = async () => [{ address: '10.1.2.3', family: 4 as const }];
    await assert.rejects(
      safeFetch('https://looks-public.example.com/', { policy: STRICT, resolver }),
      (e: unknown) => e instanceof SafeFetchError && e.code === 'blocked',
    );
  });

  it('defeats DNS rebinding: public answer first, private answer at connect time', async () => {
    let calls = 0;
    const resolver = async () => {
      calls++;
      return [{ address: calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 as const }];
    };
    await assert.rejects(
      safeFetch('http://rebind.example.com/', { policy: STRICT, resolver, timeoutMs: 3000 }),
      (e: unknown) => e instanceof SafeFetchError && e.code === 'blocked',
    );
    assert.ok(calls >= 2, 'resolver must be consulted again at connect time');
  });

  it('rejects when any one of several resolved addresses is private', async () => {
    const resolver = async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '192.168.0.10', family: 4 as const },
    ];
    await assert.rejects(safeFetch('https://mixed.example.com/', { policy: STRICT, resolver }), (e: unknown) => e instanceof SafeFetchError && e.code === 'blocked');
  });

  it('detects redirect loops', async () => {
    await assert.rejects(safeFetch(`${base}/loop-a`, { policy: DEV }), (e: unknown) => e instanceof SafeFetchError && e.code === 'redirect_loop');
  });

  it('caps the number of redirects', async () => {
    await assert.rejects(safeFetch(`${base}/chain?n=0`, { policy: DEV, maxRedirects: 3 }), (e: unknown) => e instanceof SafeFetchError && e.code === 'too_many_redirects');
  });

  it('caps downloaded bytes and flags truncation', async () => {
    const r = await safeFetch(`${base}/big`, { policy: DEV, maxBytes: 50_000 });
    assert.equal(r.bytes, 50_000);
    assert.equal(r.truncated, true);
  });

  it('times out slow servers', async () => {
    await assert.rejects(safeFetch(`${base}/slow`, { policy: DEV, timeoutMs: 400 }), (e: unknown) => e instanceof SafeFetchError && e.code === 'timeout');
  });

  it('reports connection refused as a friendly error', async () => {
    const free = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address() as AddressInfo;
        s.close(() => resolve(port));
      });
    });
    await assert.rejects(safeFetch(`http://127.0.0.1:${free}/`, { policy: DEV }), (e: unknown) => e instanceof SafeFetchError && e.code === 'refused');
  });

  it('rejects non-http schemes', async () => {
    await assert.rejects(safeFetch('file:///etc/passwd', { policy: DEV }), (e: unknown) => e instanceof SafeFetchError);
  });
});

describe('guarded proxy', () => {
  async function viaProxy(proxyPort: number, targetUrl: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const u = new URL(targetUrl);
      const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: targetUrl, headers: { host: u.host } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  function connectThrough(proxyPort: number, authority: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(proxyPort, '127.0.0.1', () => sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
      let data = '';
      sock.on('data', (c) => {
        data += c.toString();
        if (data.includes('\r\n\r\n')) {
          sock.destroy();
          resolve(data.split('\r\n')[0] ?? '');
        }
      });
      sock.on('error', reject);
      sock.setTimeout(3000, () => {
        sock.destroy();
        reject(new Error('timeout'));
      });
    });
  }

  it('forwards plain HTTP to a permitted destination (dev policy)', async () => {
    const proxy = await startGuardedProxy({ policy: DEV });
    try {
      const r = await viaProxy(proxy.port, `${base}/ok`);
      assert.equal(r.status, 200);
      assert.match(r.body, /Hello/);
    } finally {
      await proxy.close();
    }
  });

  it('refuses loopback destinations under the strict policy and records the event', async () => {
    const events: string[] = [];
    const proxy = await startGuardedProxy({ policy: STRICT, allowedPorts: new Set([Number(new URL(base).port)]), onBlocked: (e) => events.push(e.host) });
    try {
      const r = await viaProxy(proxy.port, `${base}/ok`);
      assert.equal(r.status, 403);
      assert.deepEqual(events, ['127.0.0.1']);
      assert.equal(proxy.blocked.length, 1);
    } finally {
      await proxy.close();
    }
  });

  it('refuses CONNECT tunnels to the metadata endpoint even in dev mode', async () => {
    const proxy = await startGuardedProxy({ policy: DEV });
    try {
      const status = await connectThrough(proxy.port, '169.254.169.254:80');
      assert.match(status, /403/);
    } finally {
      await proxy.close();
    }
  });

  it('refuses CONNECT to disallowed ports under the strict policy', async () => {
    const proxy = await startGuardedProxy({ policy: STRICT, resolver: async () => [{ address: '93.184.216.34', family: 4 }] });
    try {
      const status = await connectThrough(proxy.port, 'example.com:22');
      assert.match(status, /403/);
    } finally {
      await proxy.close();
    }
  });

  it('refuses CONNECT to a hostname that resolves privately', async () => {
    const proxy = await startGuardedProxy({ policy: STRICT, resolver: async () => [{ address: '10.0.0.7', family: 4 }] });
    try {
      const status = await connectThrough(proxy.port, 'sneaky.example.com:443');
      assert.match(status, /403/);
    } finally {
      await proxy.close();
    }
  });
});
