import type { CheckOutcome } from '@nba/shared';
import { skipUnlessHtml } from '../browser/open-page.js';
import type { ModuleResult, TestModule } from './types.js';

interface Metric { id: string; label: string; good: number; poor: number; unit: 'ms' | ''; fmt: (n: number) => string }
const METRICS: Metric[] = [
  { id: 'first-contentful-paint', label: 'First Contentful Paint', good: 1800, poor: 3000, unit: 'ms', fmt: (n) => `${(n / 1000).toFixed(1)} s` },
  { id: 'largest-contentful-paint', label: 'Largest Contentful Paint', good: 2500, poor: 4000, unit: 'ms', fmt: (n) => `${(n / 1000).toFixed(1)} s` },
  { id: 'total-blocking-time', label: 'Total Blocking Time', good: 200, poor: 600, unit: 'ms', fmt: (n) => `${Math.round(n)} ms` },
  { id: 'cumulative-layout-shift', label: 'Cumulative Layout Shift', good: 0.1, poor: 0.25, unit: '', fmt: (n) => n.toFixed(3) },
  { id: 'speed-index', label: 'Speed Index', good: 3400, poor: 5800, unit: 'ms', fmt: (n) => `${(n / 1000).toFixed(1)} s` },
  { id: 'server-response-time', label: 'Server response time (TTFB)', good: 600, poor: 1800, unit: 'ms', fmt: (n) => `${Math.round(n)} ms` },
];
const OPPORTUNITIES = ['render-blocking-resources', 'unused-javascript', 'unused-css-rules', 'uses-text-compression', 'uses-optimized-images', 'modern-image-formats', 'uses-responsive-images', 'offscreen-images', 'unminified-javascript', 'unminified-css', 'uses-long-cache-ttl', 'total-byte-weight', 'dom-size', 'redirects'];

export const performanceModule: TestModule = {
  id: 'performance',
  async run(ctx): Promise<ModuleResult> {
    const skip = skipUnlessHtml(ctx, 'Performance testing');
    if (skip) return skip;
    const session = await ctx.browser();
    const proxy = session.proxyServer;
    if (!proxy) return { status: 'blocked', note: 'The guarded network proxy was not available, so Lighthouse was not run.', outcomes: [] };

    const [{ launch }, lh] = await Promise.all([import('chrome-launcher'), import('lighthouse')]);
    const lighthouse = lh.default;
    const noSandbox = typeof process.getuid === 'function' && process.getuid() === 0;
    const chrome = await launch({
      chromePath: session.executablePath || undefined,
      chromeFlags: ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', `--proxy-server=${proxy}`, '--proxy-bypass-list=<-loopback>', ...(noSandbox ? ['--no-sandbox'] : [])],
    });
    const onAbort = () => void chrome.kill();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const run = await lighthouse(ctx.target.url, { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance'], throttlingMethod: 'simulate' });
      if (!run) throw new Error('Lighthouse returned no result');
      const lhr = run.lhr;
      if (lhr.runtimeError) {
        const msg = `Lighthouse could not measure this page: ${lhr.runtimeError.message?.slice(0, 200) ?? lhr.runtimeError.code}`;
        return { status: 'blocked', note: msg, error: msg, outcomes: [{ checkKey: 'lighthouse_run', title: 'Lighthouse performance audit', status: 'blocked', message: msg }] };
      }
      const out: CheckOutcome[] = [];
      const score = Math.round((lhr.categories.performance?.score ?? 0) * 100);
      out.push({ checkKey: 'performance_score', title: 'Lighthouse performance score', status: score >= 90 ? 'pass' : score >= 50 ? 'warning' : 'fail', severity: score >= 50 ? 'medium' : 'high', confidence: 'confirmed', affectedUrl: ctx.target.url, message: `Performance score ${score}/100 (simulated mobile, single run from one location; results vary between runs).`, evidence: { score, formFactor: lhr.configSettings.formFactor, lighthouse: lhr.lighthouseVersion }, recommendation: 'Work through the metrics and opportunities below, largest first.' });
      for (const m of METRICS) {
        const v = lhr.audits[m.id]?.numericValue;
        if (typeof v !== 'number') { out.push({ checkKey: `metric_${m.id}`, title: m.label, status: 'skipped', message: `${m.label} was not reported for this page.` }); continue; }
        const st = v <= m.good ? 'pass' : v <= m.poor ? 'warning' : 'fail';
        out.push({ checkKey: `metric_${m.id}`, title: m.label, status: st, severity: st === 'fail' ? 'high' : 'medium', confidence: 'confirmed', affectedUrl: ctx.target.url, message: `${m.label}: ${m.fmt(v)} (good ≤ ${m.fmt(m.good)}, poor > ${m.fmt(m.poor)}).`, evidence: { value: v, good: m.good, poor: m.poor }, recommendation: `Improve ${m.label}. See https://web.dev/articles/${m.id.replace('server-response-time', 'ttfb')}` });
      }
      for (const id of OPPORTUNITIES) {
        const a = lhr.audits[id];
        if (!a || a.score === null || a.score === undefined || a.score >= 0.9) continue;
        out.push({ checkKey: `opportunity_${id}`, title: a.title, status: 'warning', severity: 'low', confidence: 'confirmed', affectedUrl: ctx.target.url, message: `${a.title}${a.displayValue ? ` — ${a.displayValue}` : ''}.`, evidence: { audit: id, displayValue: a.displayValue ?? null }, recommendation: (a.description ?? '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 300) });
      }
      return { status: 'completed', outcomes: out, checkpoint: { score } };
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      await chrome.kill();
    }
  },
};
