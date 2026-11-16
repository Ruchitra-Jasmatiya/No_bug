/**
 * Pagination testing and site page validation, in both directions: real problems are found,
 * a healthy pager is not accused, and "no pagination" is reported as skipped, never as a pass.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { ModuleId } from '@nba/shared';
import * as cheerio from 'cheerio';
import { detectPagination } from '../src/modules/pagination.js';
import { Orchestrator } from '../src/orchestrator.js';
import { DB_URL, setupDb, silentLogger, testConfig, type TestDb } from './helpers.js';

const suite = DB_URL ? describe : describe.skip;

const page = (title: string, body: string, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main>${body}</main></body></html>`;

function startSite(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, html: string) => res.writeHead(code, { 'content-type': 'text/html' }).end(html);
    switch (u.pathname) {
      // A healthy three-page list with numbered links and rel=next.
      case '/shop': {
        const n = Number(u.searchParams.get('page') ?? '1');
        const next = n < 3 ? `<a rel="next" href="/shop?page=${n + 1}">Next</a>` : '';
        return send(200, page(`Shop page ${n}`, `<h1>Shop</h1><p>Products ${n * 10 - 9} to ${n * 10}</p><nav class="pagination"><a href="/shop?page=1">1</a><a href="/shop?page=2">2</a><a href="/shop?page=3">3</a>${next}</nav>`, n < 3 ? `<link rel="next" href="/shop?page=${n + 1}">` : ''));
      }
      // Page 2 is missing, page 3 repeats page 1, and "next" points at the page itself.
      case '/broken-pager':
        return send(200, page('Broken pager', `<h1>Articles</h1><p>First page of articles</p><nav class="pagination"><a href="/broken-pager">1</a><a href="/gone?page=2">2</a><a href="/same?page=3">3</a><a rel="next" href="/broken-pager">Next</a></nav>`, '<link rel="next" href="/broken-pager">'));
      case '/gone':
        return send(404, page('Not found', '<h1>Missing</h1>'));
      case "/same":
        return send(200, page('Broken pager', `<h1>Articles</h1><p>First page of articles</p><nav class="pagination"><a href="/broken-pager">1</a></nav>`));
      // Next links loop: a -> b -> a.
      case '/loop-a':
        return send(200, page('Loop A', '<h1>A</h1><p>alpha</p><a rel="next" href="/loop-b">Next</a>', '<link rel="next" href="/loop-b">'));
      case '/loop-b':
        return send(200, page('Loop B', '<h1>B</h1><p>beta</p><a rel="next" href="/loop-a">Next</a>', '<link rel="next" href="/loop-a">'));
      // JavaScript pagination: the button really appends content.
      case '/load-more':
        return send(200, page('Load more', '<h1>Feed</h1><ul id="l"><li>one</li></ul><button id="m" onclick="document.getElementById(\'l\').insertAdjacentHTML(\'beforeend\',\'<li>two</li><li>three</li>\')">Load more</button>'));
      // ... and a button that does nothing.
      case '/dead-more':
        return send(200, page('Dead load more', '<h1>Feed</h1><ul><li>one</li></ul><button id="m">Load more</button>'));
      case '/plain':
        return send(200, page('Plain page', '<h1>Just text</h1><p>No pager here.</p>'));
      // Site page crawl.
      case '/site':
        return send(200, page('Site home', '<nav><a href="/about">About</a><a href="/contact">Contact</a><a href="/oops">Oops</a><a href="/missing">Missing</a><a href="/logout">Log out</a></nav>'));
      case '/about':
        return send(200, page('Site home', '<h1>About</h1>')); // same title as the home page
      case '/contact':
        return send(200, '<!doctype html><html><body><h1>Contact</h1></body></html>'); // no title
      case '/oops':
        return send(500, page('Error', '<h1>Server error</h1>'));
      case '/logout':
        server.emit('logout-hit');
        return send(200, page('Logged out', ''));
      case '/lonely':
        return send(200, page('Lonely', '<h1>No links at all</h1>'));
      default:
        return send(404, page('Not found', '<h1>Not found</h1>'));
    }
  });
  let logoutHit = false;
  server.on('logout-hit', () => { logoutHit = true; });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); void logoutHit; }),
      }),
    ),
  );
}

describe('pagination detection (pure)', () => {
  it('finds numbered links, next and previous in a pager container', () => {
    const $ = cheerio.load('<nav class="pagination"><a href="/l?page=1">1</a><a href="/l?page=2">2</a><a href="/l?page=3">3</a><a href="/l?page=2">Previous</a><a href="/l?page=3">Next</a></nav>');
    const d = detectPagination($, 'http://example.com/l?page=1');
    assert.deepEqual([...d.numbered.keys()], [1, 2, 3]);
    assert.equal(d.next, 'http://example.com/l?page=3');
    assert.equal(d.prev, 'http://example.com/l?page=2');
  });
  it('reads rel=next from <link> and recognises /page/N paths', () => {
    const $ = cheerio.load('<head><link rel="next" href="/blog/page/2/"></head><body><a href="/blog/page/2/">2</a></body>');
    const d = detectPagination($, 'http://example.com/blog/');
    assert.equal(d.relNext, 'http://example.com/blog/page/2/');
    assert.ok(d.numbered.has(2));
  });
  it('ignores other origins and finds nothing on a page without pagination', () => {
    const $ = cheerio.load('<nav class="pagination"><a href="https://other.example/?page=2">2</a></nav><a href="/about">About</a>');
    const d = detectPagination($, 'http://example.com/');
    assert.equal(d.numbered.size, 0);
    assert.equal(d.next, null);
  });
});

suite('pagination and site pages modules', () => {
  let db: TestDb;
  let site: Awaited<ReturnType<typeof startSite>>;
  before(async () => {
    db = await setupDb();
    site = await startSite();
  });
  after(async () => {
    await site.close();
    await db.cleanup();
  });

  type Row = { check_key: string; status: string; severity: string | null; message: string; affected_url: string; evidence: Record<string, unknown> };
  async function run(path: string, mod: ModuleId): Promise<{ rows: Row[]; moduleStatus: string }> {
    const jobId = await db.createJob(`${site.base}${path}`, [mod]);
    await new Orchestrator({ store: db.store, config: testConfig(), logger: silentLogger, policy: { allowPrivateTargets: true } }).runJob(jobId);
    const rows = (await db.pool.query<Row>(`select * from public.test_results where job_id=$1 and module_id=$2`, [jobId, mod])).rows;
    const m = await db.pool.query(`select status from public.test_modules where job_id=$1 and module_id=$2`, [jobId, mod]);
    if (process.env.DEBUG_ROWS) console.log(JSON.stringify(rows.map((r) => [r.check_key, r.status, r.severity, r.affected_url])));
    return { rows, moduleStatus: m.rows[0].status };
  }
  const has = (rows: Row[], re: RegExp, status?: string) => rows.some((r) => re.test(r.check_key) && (!status || r.status === status));

  it('a healthy pager passes: links load, content differs, next chain is followed', async () => {
    const { rows, moduleStatus } = await run('/shop?page=1', 'pagination');
    assert.equal(moduleStatus, 'completed');
    assert.deepEqual(rows.filter((r) => r.status === 'fail' || r.status === 'warning'), []);
    assert.ok(has(rows, /^pagination_links$/, 'pass'));
    assert.ok(has(rows, /^pagination_content$/, 'pass'));
    assert.ok(has(rows, /^pagination_chain$/, 'pass'));
  });

  it('finds a broken page link, a "next" that points at itself, and identical content', async () => {
    const { rows } = await run('/broken-pager', 'pagination');
    assert.ok(has(rows, /^pagination_broken_/, 'fail'), 'broken numbered link');
    assert.ok(has(rows, /^pagination_next_self$/, 'fail'), 'next points at the same page');
    assert.ok(has(rows, /^pagination_same_content$/, 'warning'), 'identical content');
    assert.ok(!has(rows, /^pagination_links$/, 'pass'), 'must not claim the links are fine');
  });

  it('detects a loop in the next chain', async () => {
    const { rows } = await run('/loop-a', 'pagination');
    assert.ok(has(rows, /^pagination_next_loop$/, 'fail'));
  });

  it('a page without pagination is skipped (not applicable), never passed', async () => {
    const { rows, moduleStatus } = await run('/plain', 'pagination');
    assert.equal(moduleStatus, 'completed');
    assert.ok(has(rows, /^pagination_none$/, 'skipped'));
    assert.equal(rows.filter((r) => r.status === 'pass').length, 0);
  });

  it('clicks a real "Load more" button and verifies the page changed', async () => {
    const { rows } = await run('/load-more', 'pagination');
    assert.ok(has(rows, /^pagination_js_control$/, 'pass'));
  });

  it('warns when a "Load more" button changes nothing', async () => {
    const { rows } = await run('/dead-more', 'pagination');
    const r = rows.find((x) => x.check_key === 'pagination_js_control');
    assert.equal(r?.status, 'warning');
  });

  it('site pages: reports HTTP errors, missing and duplicate titles, and never requests a logout link', async () => {
    const { rows, moduleStatus } = await run('/site', 'site_pages');
    assert.equal(moduleStatus, 'completed');
    assert.ok(rows.some((r) => r.status === 'fail' && /\/oops$/.test(r.affected_url) && r.severity === 'high'), '500 page');
    assert.ok(rows.some((r) => r.status === 'fail' && /\/missing$/.test(r.affected_url)), '404 page');
    assert.ok(has(rows, /^pages_missing_title$/, 'warning'));
    assert.ok(has(rows, /^pages_duplicate_titles$/, 'warning'));
    assert.ok(!has(rows, /^pages_reachable$/, 'pass'), 'must not claim all pages respond');
    const crawled = rows.find((r) => r.check_key === 'pages_crawled');
    assert.ok(crawled);
    assert.equal((crawled.evidence as { checked: number }).checked, 4, 'the logout link is excluded from the crawl');
  });

  it('site pages: a page that links nowhere is skipped (not applicable)', async () => {
    const { rows } = await run('/lonely', 'site_pages');
    assert.ok(has(rows, /^pages_none$/, 'skipped'));
  });
});
