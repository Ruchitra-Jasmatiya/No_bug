/**
 * Timing harness: runs the REAL orchestrator over a local multi-page site with simulated network latency
 * and prints how long each module took.
 *
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/nba_test CHROME_EXECUTABLE_PATH=/usr/bin/google-chrome \
 *     node --import tsx worker/bench/bench.ts [latencyMs]
 *
 * The site is local, so "slow server" is simulated with a fixed per-request delay. It is a measurement aid,
 * not a claim about any specific real website.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Orchestrator } from '../src/orchestrator.js';
import { setupDb, silentLogger, testConfig } from '../test/helpers.js';

const LATENCY = Number(process.argv[2] ?? 120);
const PAGES = 12;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function page(n: number): string {
  const imgs = Array.from({ length: 20 }, (_, i) => `<img src="/img/${n}-${i}.png" alt="Product ${i}" width="120" height="120">`).join('');
  const links = Array.from({ length: PAGES }, (_, i) => `<a href="/p/${i + 1}">Page ${i + 1}</a>`).join(' ');
  const items = Array.from({ length: 10 }, (_, i) => `<li><a href="/item/${n}-${i}">Item ${n}-${i}</a></li>`).join('');
  const next = n < PAGES ? `<a rel="next" href="/p/${n + 1}">Next</a>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Catalogue page ${n}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Catalogue page ${n} of a demo shop used to measure test speed."></head>
<body><main><h1>Catalogue ${n}</h1><nav>${links}</nav><ul>${items}</ul><div>${imgs}</div>
<form action="/search"><label for="q">Search</label><input id="q" name="q"><button type="submit">Go</button></form>${next}
<button id="b">Load more</button></main><script>document.getElementById('b').onclick=function(){fetch('/api/more')}</script></body></html>`;
}

const server = http.createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  setTimeout(() => {
    if (path === '/' || path.startsWith('/p/')) {
      const n = path === '/' ? 1 : Number(path.split('/')[2]);
      res.writeHead(200, { 'content-type': 'text/html' }).end(page(Number.isFinite(n) ? n : 1));
    } else if (path.startsWith('/img/')) res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    else if (path.startsWith('/item/')) res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html lang="en"><title>Item</title><h1>Item</h1></html>');
    else if (path === '/api/more') res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    else if (path === '/robots.txt') res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\n');
    else res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
  }, LATENCY);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const db = await setupDb();
try {
  await db.pool.query(`delete from public.test_jobs where status in ('queued','running')`);
  const jobId = await db.createJob(`${base}/`);
  const t0 = Date.now();
  const outcome = await new Orchestrator({ store: db.store, config: testConfig(), logger: silentLogger, policy: { allowPrivateTargets: true } }).runJob(jobId);
  const total = Date.now() - t0;
  const { rows } = await db.pool.query(`select module_id, status, duration_ms from public.test_modules where job_id = $1 order by position`, [jobId]);
  console.log(`\nlatency=${LATENCY}ms/request  outcome=${outcome}`);
  for (const r of rows) console.log(`${String(r.module_id).padEnd(20)} ${String(r.status).padEnd(10)} ${(Number(r.duration_ms ?? 0) / 1000).toFixed(1).padStart(6)}s`);
  console.log(`${'TOTAL'.padEnd(31)} ${(total / 1000).toFixed(1).padStart(6)}s`);
} finally {
  await db.cleanup();
  await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  process.exit(0);
}
