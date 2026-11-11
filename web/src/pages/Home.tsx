import { motion, useReducedMotion } from 'framer-motion';
import { Accessibility, Bug, Eye, Gauge, Globe, Layers, Link2, Lock, MonitorSmartphone, MousePointerClick, Network, Search, ShieldCheck, Smartphone, Sparkles, Terminal, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mascot } from '../components/Mascot';
import { StartTestForm } from '../components/StartTestForm';
import { get } from '../lib/api';
import { useDocumentTitle } from '../lib/ui';

interface Stats {
  testsRun: number;
  issuesFound: number;
  sitesTested: number;
  checksRun: number;
}
interface Mod {
  id: string;
  label: string;
  description: string;
  system: boolean;
  implemented: boolean;
  enabled: boolean;
}

const ICONS: Record<string, typeof Bug> = {
  connectivity: Globe, browser_launch: Terminal, page_inspection: Search, console: Bug, functional: MousePointerClick, ui: Layers, responsive: Smartphone,
  performance: Gauge, accessibility: Accessibility, seo: Search, security: Lock, links_resources: Link2, api: Network, visual_regression: Eye, pwa: MonitorSmartphone,
  ai_analysis: Sparkles, report_generation: Workflow,
};

export default function Home() {
  useDocumentTitle('Website testing with BUGSY');
  const [stats, setStats] = useState<Stats | null>(null);
  const [mods, setMods] = useState<Mod[] | null>(null);
  useEffect(() => {
    get<Stats>('/api/public/stats').then(setStats).catch(() => setStats(null));
    get<{ modules: Mod[] }>('/api/modules').then((r) => setMods(r.modules)).catch(() => setMods(null));
  }, []);

  return (
    <>
      <section className="hero">
        <div className="wrap hero-grid">
          <div className="stack" style={{ ['--gap' as string]: '22px' }}>
            <motion.h1 className="hero-title" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
              Your Website Deserves a Bug-Free Experience.
            </motion.h1>
            <p className="lead">
              Paste a URL. A real browser tests it, then BUGSY explains every problem with evidence and a suggested fix, in plain language.
            </p>
            <div className="card" style={{ padding: 20, maxWidth: 640 }}>
              <StartTestForm />
            </div>
          </div>
          <ScanStage />
        </div>
      </section>

      <section className="wrap section" aria-label="Platform numbers">
        <div className="stat-strip">
          {stats && stats.testsRun > 0 ? (
            <>
              <div className="stat"><b>{stats.testsRun.toLocaleString()}</b><span>tests completed</span></div>
              <div className="stat"><b>{stats.sitesTested.toLocaleString()}</b><span>websites tested</span></div>
              <div className="stat"><b>{stats.checksRun.toLocaleString()}</b><span>individual checks run</span></div>
              <div className="stat"><b>{stats.issuesFound.toLocaleString()}</b><span>issues reported with evidence</span></div>
            </>
          ) : (
            <p className="muted" style={{ gridColumn: '1 / -1' }}>{stats ? 'No tests have been completed yet. Yours could be the first.' : 'Live numbers appear here once the platform has finished tests.'}</p>
          )}
        </div>
      </section>

      <section id="how" className="wrap section">
        <h2 className="h2">How a test works</h2>
        <ol className="steps">
          {[
            ['Enter your URL', 'We check it is a public website and refuse anything that points at private networks.'],
            ['A real browser visits it', 'Chromium loads the page, clicks around, resizes, and records what actually happens.'],
            ['BUGSY explains the findings', 'Each issue comes with the evidence, how sure we are, and a fix you can copy.'],
            ['Fix, then run it again', 'Re-run the same site and compare against your previous report.'],
          ].map(([t, d], i) => (
            <motion.li key={t} className="step" initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-60px' }} transition={{ delay: i * 0.07 }}>
              <span className="step-n" aria-hidden="true">{i + 1}</span>
              <h3>{t}</h3>
              <p className="muted">{d}</p>
            </motion.li>
          ))}
        </ol>
      </section>

      <section id="modules" className="wrap section">
        <div className="row spread" style={{ alignItems: 'flex-end' }}>
          <div>
            <h2 className="h2">What gets tested</h2>
            <p className="muted" style={{ maxWidth: 560, marginTop: 8 }}>This list comes straight from the server, so it only shows checks that really run.</p>
          </div>
        </div>
        <div className="grid-cards">
          {(mods ?? []).filter((m) => m.implemented).map((m) => {
            const Icon = ICONS[m.id] ?? Bug;
            return (
              <div key={m.id} className="card-flat module-card">
                <span className="module-icon"><Icon size={22} /></span>
                <div>
                  <h3>{m.label}</h3>
                  <p className="muted small">{m.description}</p>
                </div>
              </div>
            );
          })}
          {mods === null && Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 96, borderRadius: 14 }} />)}
        </div>
      </section>

      <section className="wrap section">
        <h2 className="h2">Why you can trust the report</h2>
        <div className="why-grid">
          {[
            [ShieldCheck, 'It never says “bug-free”', 'If nothing is found the report says “No issues detected in the tests performed” and lists anything that was skipped.'],
            [Eye, 'Evidence first', 'Every issue shows what the browser saw: the URL, the message, the status code. AI explanations are labelled and kept separate.'],
            [Lock, 'Safe by design', 'Targets on private networks are blocked, tests are read-only, and your results are visible only to you.'],
            [Workflow, 'Survives a refresh', 'Tests run on the server. Close the tab, lose Wi-Fi, come back later: your progress is still there.'],
          ].map(([Icon, t, d]) => {
            const I = Icon as typeof Bug;
            return (
              <div key={t as string} className="why">
                <I size={26} />
                <h3>{t as string}</h3>
                <p className="muted">{d as string}</p>
              </div>
            );
          })}
        </div>
      </section>

      <SampleReport />

      <section className="wrap section">
        <div className="card card-sage bugsy-intro">
          <Mascot size={120} mood="happy" />
          <div className="stack">
            <h2 className="h2" style={{ color: 'var(--cream)' }}>Meet BUGSY</h2>
            <p style={{ maxWidth: 560 }}>
              BUGSY reads your real test results and answers questions about them: what an error means, what to fix first, what changed since your last run. When it does not know, it says so.
            </p>
            <div><Link className="btn btn-yellow" to="/signup">Create a free account</Link></div>
          </div>
        </div>
      </section>

      <section className="wrap section" style={{ textAlign: 'center' }}>
        <h2 className="h2">Ready to see what your site is hiding?</h2>
        <p className="muted" style={{ margin: '10px auto 22px', maxWidth: 480 }}>It takes a minute to start. You get the report when the tests are done.</p>
        <Link className="btn btn-yellow" to="#top" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); document.getElementById('site-url')?.focus({ preventScroll: true }); }}>Test my website</Link>
      </section>
    </>
  );
}

/** Flat, looping demo of a scan. Illustrative only: the label says so. */
function ScanStage() {
  const reduce = useReducedMotion();
  const pins = [
    { x: 262, y: 74, label: 'Console error', c: 'var(--sev-high)', t: 1.2 },
    { x: 70, y: 176, label: 'Low contrast text', c: 'var(--sev-medium)', t: 2.4 },
    { x: 276, y: 226, label: 'Broken link', c: 'var(--sev-critical)', t: 3.6 },
    { x: 96, y: 292, label: 'Missing alt text', c: 'var(--sev-low)', t: 4.8 },
  ];
  return (
    <div className="stage" aria-hidden="true">
      <div className="stage-label">Illustration of a scan</div>
      <svg viewBox="0 0 400 360" width="100%">
        <rect x="6" y="6" width="388" height="348" rx="18" fill="var(--paper)" stroke="var(--sage-dark)" strokeWidth="3" />
        <rect x="6" y="6" width="388" height="34" rx="18" fill="var(--sage)" stroke="var(--sage-dark)" strokeWidth="3" />
        <circle cx="26" cy="23" r="5" fill="var(--butter-deep)" /><circle cx="42" cy="23" r="5" fill="var(--cream)" /><circle cx="58" cy="23" r="5" fill="var(--cream)" />
        <rect x="84" y="14" width="250" height="18" rx="9" fill="var(--cream)" />
        <rect x="30" y="64" width="150" height="16" rx="5" fill="var(--sage-soft)" />
        <rect x="30" y="92" width="220" height="10" rx="4" fill="var(--cream-3)" /><rect x="30" y="110" width="190" height="10" rx="4" fill="var(--cream-3)" />
        <rect x="262" y="64" width="104" height="60" rx="10" fill="var(--butter)" stroke="var(--sage-dark)" strokeWidth="2" />
        <rect x="30" y="150" width="336" height="60" rx="12" fill="var(--sage-mist)" />
        <rect x="46" y="170" width="120" height="10" rx="4" fill="var(--cream-3)" />
        <rect x="46" y="188" width="90" height="10" rx="4" fill="var(--cream-3)" />
        <rect x="30" y="224" width="100" height="36" rx="18" fill="var(--sage)" />
        <rect x="266" y="236" width="100" height="14" rx="5" fill="var(--sage-soft)" />
        <rect x="30" y="276" width="336" height="50" rx="12" fill="var(--butter)" />
        <rect x="46" y="294" width="70" height="14" rx="5" fill="var(--cream-3)" />
        {!reduce && (
          <motion.rect x="8" width="384" height="4" fill="var(--sage-dark)" initial={{ y: 42 }} animate={{ y: [42, 336, 42] }} transition={{ duration: 6, repeat: Infinity, ease: 'linear' }} />
        )}
        {pins.map((p) => (
          <motion.g key={p.label} initial={reduce ? false : { opacity: 0, scale: 0.4 }} animate={reduce ? { opacity: 1 } : { opacity: [0, 1, 1, 0], scale: [0.4, 1, 1, 0.9] }} transition={{ duration: 6, delay: reduce ? 0 : p.t - 1, repeat: Infinity, times: [0, 0.08, 0.85, 1] }} style={{ transformOrigin: `${p.x}px ${p.y}px` }}>
            <circle cx={p.x} cy={p.y} r="11" fill={p.c} stroke="var(--sage-dark)" strokeWidth="2.5" />
            <path d={`M${p.x - 4} ${p.y - 2}l3 3 5-6`} stroke="var(--paper)" strokeWidth="2.4" fill="none" strokeLinecap="round" />
            <rect x={p.x - 8} y={p.y + 16} width={p.label.length * 6.6 + 18} height="22" rx="11" fill="var(--ink)" />
            <text x={p.x + 1} y={p.y + 31} fontSize="11" fontWeight="600" fill="var(--cream)" fontFamily="var(--font-body)">{p.label}</text>
          </motion.g>
        ))}
      </svg>
      <motion.div className="stage-bugsy" animate={reduce ? undefined : { x: [0, 8, 0] }} transition={{ duration: 3, repeat: Infinity }}>
        <Mascot size={84} mood="thinking" />
      </motion.div>
    </div>
  );
}

function SampleReport() {
  return (
    <section className="wrap section">
      <div className="row spread" style={{ alignItems: 'flex-end', marginBottom: 18 }}>
        <h2 className="h2">What a report looks like</h2>
        <span className="tag">Example for illustration, not a real test</span>
      </div>
      <div className="sample">
        <div className="card">
          <div className="row spread">
            <div>
              <b style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem' }}>shop.example.com</b>
              <div className="muted small">4 issues detected in the tests performed</div>
            </div>
            <span className="tag">Some modules skipped</span>
          </div>
          <hr className="divider" />
          {[
            ['high', 'Unhandled exception: cart is undefined', 'Confirmed', 'Console'],
            ['medium', 'Text contrast is too low on 3 elements', 'Confirmed', 'Accessibility'],
            ['low', 'Image without alternative text', 'Potential', 'SEO'],
          ].map(([sev, t, conf, cat]) => (
            <div key={t} className="sample-row">
              <span className={`sev sev-${sev}`}>{sev}</span>
              <div className="grow"><b>{t}</b><div className="muted small">{cat} · {conf}</div></div>
            </div>
          ))}
        </div>
        <div className="card card-butter">
          <b style={{ fontFamily: 'var(--font-display)' }}>Suggested fix</b>
          <p className="small" style={{ margin: '8px 0 12px' }}>Initialise <code className="mono">cart</code> before the first render, or guard the access with <code className="mono">cart?.items</code>.</p>
          <b style={{ fontFamily: 'var(--font-display)' }}>BUGSY says</b>
          <p className="small" style={{ marginTop: 8 }}>This error fires on page load, so every visitor sees a broken cart badge. Fix this one first.</p>
        </div>
      </div>
    </section>
  );
}
