import { m as motion } from 'framer-motion';
import { Accessibility, Bug, Eye, FileText, Gauge, Globe, Layers, ListOrdered, Link2, Lock, MonitorSmartphone, MousePointerClick, Network, Search, ShieldCheck, Smartphone, Sparkles, Terminal, Workflow } from 'lucide-react';
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
  pagination: ListOrdered, site_pages: FileText, ai_analysis: Sparkles, report_generation: Workflow,
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
              Paste a URL. A real browser tests pages, links, images, pagination, accessibility, performance and security, then BUGSY explains every problem with evidence and a fix.
            </p>
            <div className="card" style={{ padding: 20, maxWidth: 640 }}>
              <StartTestForm />
            </div>
          </div>
          <aside className="card" aria-label="Checks that run on every test">
            <p className="eyebrow">Runs on every test</p>
            <div className="coverage">
              {mods === null && Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 22, margin: '10px 0' }} />)}
              {(mods ?? []).filter((m) => m.implemented && !m.system).map((m) => {
                const Icon = ICONS[m.id] ?? Bug;
                return <div key={m.id} className="coverage-row"><Icon size={16} style={{ color: 'var(--sage-600)' }} aria-hidden /><span className="grow">{m.label}</span></div>;
              })}
            </div>
          </aside>
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

      <section className="wrap section">
        <div className="card card-sage bugsy-intro">
          <Mascot size={72} mood="happy" />
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
