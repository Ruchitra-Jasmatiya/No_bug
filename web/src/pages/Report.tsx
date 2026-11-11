import { AnimatePresence, motion } from 'framer-motion';
import { Bot, ChevronDown, Clipboard, Download, RotateCw, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { BugDTO, ReportDTO } from '@nba/shared';
import { BarList, Legend, SeverityDonut } from '../components/Charts';
import { Mascot } from '../components/Mascot';
import { ApiError, get, post } from '../lib/api';
import { useBugsy } from '../lib/bugsy';
import { CATEGORY_LABEL, formatDate, formatDuration, pluralise, SEVERITY_ORDER, STATUS_LABEL } from '../lib/format';
import { Notice, PageLoader, SeverityBadge, Spinner, useDocumentTitle, useToast } from '../lib/ui';

interface AiBlock {
  explanation?: string;
  likelyCause?: string;
  fix?: string;
  steps?: string[];
  codeExample?: string;
  verification?: string;
  effort?: string;
}

function Issue({ bug, hostname, onAsk }: { bug: BugDTO; hostname: string; onAsk: (b: BugDTO) => void }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const ai = bug.aiAnalysis as AiBlock | null;
  const copy = async () => {
    const text = `${bug.issueCode} — ${bug.title}\n${bug.affectedUrl ?? hostname}\n\nFix: ${ai?.fix ?? bug.suggestedFix}${ai?.codeExample ? `\n\n${ai.codeExample}` : ''}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Fix copied to clipboard.');
    } catch {
      toast('Could not copy automatically. Select the text and copy it manually.', 'error');
    }
  };
  return (
    <li className={`issue issue-${bug.severity}`}>
      <button className="issue-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <SeverityBadge severity={bug.severity} />
        <span className="grow" style={{ textAlign: 'left' }}>
          <b>{bug.title}</b>
          <span className="small muted" style={{ display: 'block' }}>{bug.issueCode} · {CATEGORY_LABEL[bug.category] ?? bug.category} · {bug.confidence}</span>
        </span>
        <ChevronDown size={18} className={open ? 'rot' : ''} aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} style={{ overflow: 'hidden' }}>
            <div className="issue-body stack" style={{ ['--gap' as string]: '14px' }}>
              <p style={{ margin: 0 }}>{bug.description}</p>
              {bug.affectedUrl && <p className="small" style={{ margin: 0, wordBreak: 'break-all' }}><b>Affected:</b> <span className="mono">{bug.affectedUrl}</span></p>}
              <div>
                <p className="label" style={{ marginBottom: 4 }}>Recommended fix</p>
                <p style={{ margin: 0 }}>{bug.suggestedFix}</p>
              </div>
              {ai?.explanation && (
                <div className="ai-box">
                  <p className="label row" style={{ gap: 6, marginBottom: 6 }}><Sparkles size={15} /> BUGSY’s explanation <span className="small muted">(AI-written, not test evidence)</span></p>
                  <p style={{ margin: '0 0 8px' }}>{ai.explanation}</p>
                  {ai.likelyCause && <p className="small" style={{ margin: '0 0 8px' }}><b>Likely cause:</b> {ai.likelyCause}</p>}
                  {ai.fix && <p style={{ margin: '0 0 8px' }}><b>Suggested fix:</b> {ai.fix}</p>}
                  {ai.steps && ai.steps.length > 0 && <ol style={{ margin: '0 0 8px', paddingLeft: 20 }}>{ai.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
                  {ai.codeExample && <pre className="code">{ai.codeExample}</pre>}
                  {ai.verification && <p className="small" style={{ margin: 0 }}><b>How to verify:</b> {ai.verification}</p>}
                </div>
              )}
              {Object.keys(bug.evidence).length > 0 && (
                <details>
                  <summary className="label" style={{ cursor: 'pointer' }}>Test evidence</summary>
                  <pre className="code" style={{ marginTop: 8 }}>{JSON.stringify(bug.evidence, null, 2)}</pre>
                </details>
              )}
              <div className="row">
                <button className="btn btn-sm" onClick={copy}><Clipboard size={15} /> Copy fix</button>
                <button className="btn btn-sm btn-yellow" onClick={() => onAsk(bug)}><Bot size={15} /> Ask BUGSY</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

interface PrevItem { id: string; status: string; finishedAt: string | null; queuedAt: string; summary: { bugs: number; overall: string } | null }

export default function Report() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { setJob, ask } = useBugsy();
  const [report, setReport] = useState<ReportDTO | null>(null);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);
  const [sev, setSev] = useState<string | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [prev, setPrev] = useState<PrevItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useDocumentTitle(report ? `Report for ${report.job.hostname}` : 'Report');

  useEffect(() => {
    setReport(null);
    setError(null);
    get<ReportDTO>(`/api/tests/${id}/report`)
      .then(setReport)
      .catch((e) => {
        if (e instanceof ApiError && e.code === 'not_ready') return nav(`/tests/${id}`, { replace: true });
        setError({ message: e instanceof ApiError ? e.message : 'Could not load the report.', code: e instanceof ApiError ? e.code : 'error' });
      });
  }, [id, nav]);

  useEffect(() => {
    if (!report) return;
    const crit = report.bugs.filter((b) => b.severity === 'critical').length;
    const high = report.bugs.filter((b) => b.severity === 'high').length;
    setJob({ jobId: report.job.id, hostname: report.job.hostname, status: report.job.status, bugs: report.bugs.length, critical: crit, high, incomplete: report.summary.incomplete });
    return () => setJob(null);
  }, [report, setJob]);

  useEffect(() => {
    if (!report) return;
    get<{ items: PrevItem[] }>('/api/tests?pageSize=50')
      .then((r) => setPrev(r.items.filter((t: any) => t.hostname === report.job.hostname && t.id !== report.job.id && ['completed', 'cancelled', 'failed'].includes(t.status))))
      .catch(() => setPrev([]));
  }, [report]);

  const sevCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const b of report?.bugs ?? []) c[b.severity] = (c[b.severity] ?? 0) + 1;
    return c;
  }, [report]);
  const catCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const b of report?.bugs ?? []) c[b.category] = (c[b.category] ?? 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label: CATEGORY_LABEL[label] ?? label, value }));
  }, [report]);
  const visible = useMemo(() => (report?.bugs ?? []).filter((b) => (!sev || b.severity === sev) && (!cat || b.category === cat)), [report, sev, cat]);

  if (error) {
    return (
      <div className="wrap-narrow page"><div className="empty"><Mascot size={110} mood="alert" /><h1 style={{ fontSize: '2rem' }}>Report unavailable</h1><p className="muted">{error.message}</p><Link className="btn btn-yellow" to="/dashboard">Go to dashboard</Link></div></div>
    );
  }
  if (!report) return <PageLoader label="Loading your report" />;

  const j = report.job;
  const total = report.bugs.length;
  const cats = [...new Set(report.bugs.map((b) => b.category))];
  const notRun = report.modules.filter((m) => m.status !== 'completed');
  const duration = j.startedAt && j.finishedAt ? new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime() : null;

  const runAgain = async () => {
    setBusy('again');
    try {
      const r = await post<{ job: { id: string } }>(`/api/tests/${id}/restart`);
      nav(`/tests/${r.job.id}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not start a new test.', 'error');
      setBusy(null);
    }
  };
  const pdf = async () => {
    setBusy('pdf');
    try {
      const { downloadReportPdf } = await import('../lib/pdf');
      await downloadReportPdf(report);
    } catch {
      toast('Could not create the PDF.', 'error');
    } finally {
      setBusy(null);
    }
  };
  const askAbout = (b: BugDTO) => ask(`Explain ${b.issueCode} (${b.title}) and walk me through fixing it.`);

  const mood = j.status === 'completed' && total === 0 ? 'happy' : total > 0 ? 'alert' : 'idle';

  return (
    <div className="wrap page">
      <div className="report-head card card-butter">
        <Mascot size={96} mood={mood} />
        <div className="grow stack" style={{ ['--gap' as string]: '8px' }}>
          <p className="label muted" style={{ margin: 0 }}>Test report · {STATUS_LABEL[j.status]}</p>
          <h1 style={{ fontSize: 'clamp(1.6rem,4vw,2.4rem)', wordBreak: 'break-all' }}>{j.hostname}</h1>
          <p className="small muted" style={{ margin: 0 }}>{formatDate(j.finishedAt ?? j.queuedAt)}{duration ? ` · took ${formatDuration(duration)}` : ''} · {j.attempt > 1 ? `resumed ${pluralise(j.attempt - 1, 'time')}` : 'single run'}</p>
          <p style={{ margin: 0, fontWeight: 600 }}>{report.message}</p>
        </div>
        <div className="stack" style={{ ['--gap' as string]: '8px', minWidth: 170 }}>
          <button className="btn btn-yellow" onClick={runAgain} disabled={busy === 'again'}>{busy === 'again' ? <Spinner label="Starting" /> : <><RotateCw size={16} /> Run again</>}</button>
          <button className="btn" onClick={pdf} disabled={busy === 'pdf'}>{busy === 'pdf' ? <Spinner label="Creating PDF" /> : <><Download size={16} /> Download PDF</>}</button>
          <button className="btn btn-ghost" onClick={() => ask('Give me a short summary of this report and tell me what to fix first.')}><Bot size={16} /> Ask BUGSY</button>
        </div>
      </div>

      {report.summary.incomplete && (
        <div style={{ marginTop: 18 }}>
          <Notice>Some modules were skipped, blocked or unavailable, so this report is not exhaustive: {notRun.map((m) => m.label).join(', ')}.</Notice>
        </div>
      )}

      <div className="report-grid">
        <section className="card" aria-label="Severity breakdown">
          <h2 style={{ fontSize: '1.2rem', marginBottom: 14 }}>Issues by severity</h2>
          <div className="row" style={{ gap: 24, justifyContent: 'center' }}>
            <SeverityDonut counts={sevCounts} />
            <Legend counts={sevCounts} />
          </div>
        </section>
        <section className="card" aria-label="Issues by category">
          <h2 style={{ fontSize: '1.2rem', marginBottom: 14 }}>Issues by category</h2>
          <BarList items={catCounts} />
        </section>
        <section className="card" aria-label="Check results">
          <h2 style={{ fontSize: '1.2rem', marginBottom: 14 }}>Checks performed</h2>
          <BarList color="var(--butter-deep)" items={[
            { label: 'Passed', value: report.summary.counts.pass },
            { label: 'Failed', value: report.summary.counts.fail },
            { label: 'Warnings', value: report.summary.counts.warning },
            { label: 'Info', value: report.summary.counts.info },
            { label: 'Not run', value: report.summary.counts.skipped + report.summary.counts.blocked },
          ]} />
        </section>
      </div>

      <section style={{ marginTop: 34 }} aria-label="Issues">
        <div className="row spread" style={{ marginBottom: 12 }}>
          <h2 style={{ fontSize: '1.6rem' }}>Issues ({visible.length}{visible.length !== total ? ` of ${total}` : ''})</h2>
        </div>
        {total > 0 && (
          <div className="stack" style={{ ['--gap' as string]: '10px', marginBottom: 14 }}>
            <div className="seg" role="group" aria-label="Filter by severity">
              <button className="chip" aria-pressed={sev === null} onClick={() => setSev(null)}>All severities</button>
              {SEVERITY_ORDER.filter((s) => sevCounts[s]).map((s) => <button key={s} className="chip" aria-pressed={sev === s} onClick={() => setSev(sev === s ? null : s)} style={{ textTransform: 'capitalize' }}>{s} ({sevCounts[s]})</button>)}
            </div>
            <div className="seg" role="group" aria-label="Filter by category">
              <button className="chip" aria-pressed={cat === null} onClick={() => setCat(null)}>All categories</button>
              {cats.map((c) => <button key={c} className="chip" aria-pressed={cat === c} onClick={() => setCat(cat === c ? null : c)}>{CATEGORY_LABEL[c] ?? c}</button>)}
            </div>
          </div>
        )}
        {total === 0 ? (
          <div className="card empty"><Mascot size={100} mood="happy" /><h3>No issues detected in the tests performed.</h3><p className="muted">That is not a guarantee the site has no bugs. Review the modules below to see exactly what was covered.</p></div>
        ) : visible.length === 0 ? (
          <p className="muted">No issues match these filters.</p>
        ) : (
          <ul className="issues">{visible.map((b) => <Issue key={b.id} bug={b} hostname={j.hostname} onAsk={askAbout} />)}</ul>
        )}
      </section>

      <section style={{ marginTop: 34 }} aria-label="Modules">
        <h2 style={{ fontSize: '1.4rem', marginBottom: 12 }}>What was tested</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Module</th><th>Status</th><th>Passed</th><th>Failed</th><th>Warnings</th><th>Note</th></tr></thead>
            <tbody>
              {report.modules.map((m) => (
                <tr key={m.moduleId}><td><b>{m.label}</b></td><td>{STATUS_LABEL[m.status] ?? m.status}</td><td>{m.counts.pass}</td><td>{m.counts.fail}</td><td>{m.counts.warning}</td><td className="small muted">{m.errorMessage ?? m.note ?? ''}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {prev.length > 0 && (
        <section style={{ marginTop: 34 }} aria-label="Previous reports">
          <h2 style={{ fontSize: '1.4rem', marginBottom: 12 }}>Previous reports for {j.hostname}</h2>
          <ul className="issues">
            {prev.map((p) => (
              <li key={p.id} className="card card-flat row spread" style={{ padding: '12px 16px' }}>
                <span>{formatDate(p.finishedAt ?? p.queuedAt)} · {STATUS_LABEL[p.status] ?? p.status}{p.summary ? ` · ${pluralise(p.summary.bugs, 'issue')}` : ''}</span>
                <Link className="btn btn-sm btn-ghost" to={`/reports/${p.id}`}>Open</Link>
              </li>
            ))}
          </ul>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={() => ask('Compare this report with my previous report for this site. What was fixed, what is new, what remains?')}>Compare with previous report (BUGSY)</button>
        </section>
      )}
    </div>
  );
}
