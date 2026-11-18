import { AlertTriangle, Check, ChevronDown, CircleDashed, Info, Loader2, MessageCircle, MinusCircle, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogDTO, ModuleStateDTO, ResultDTO } from '@nba/shared';
import { get } from '../lib/api';
import { useBugsy } from '../lib/bugsy';
import { formatDuration } from '../lib/format';

/** One word that describes a module honestly, from its real state and real result counts. */
export function moduleVerdict(m: ModuleStateDTO): { key: string; label: string } {
  const c = m.counts;
  if (m.status === 'running') return { key: 'running', label: 'Running' };
  if (m.status === 'pending') return { key: 'pending', label: 'Queued' };
  if (m.status === 'failed') return { key: 'failed', label: 'Failed to run' };
  if (m.status === 'blocked') return { key: 'blocked', label: 'Blocked' };
  if (m.status === 'skipped') return { key: 'skipped', label: 'Not applicable' };
  if (c.fail > 0) return { key: 'fail', label: 'Issues detected' };
  if (c.warning > 0) return { key: 'warning', label: 'Warnings' };
  if (c.pass === 0 && c.info === 0) return { key: 'info', label: 'No findings' };
  return { key: 'pass', label: 'Passed' };
}

function StatusIcon({ k, size = 15 }: { k: string; size?: number }) {
  switch (k) {
    case 'running': return <Loader2 size={size} className="spin" aria-hidden />;
    case 'pass': case 'completed': return <Check size={size} aria-hidden />;
    case 'fail': case 'failed': return <XCircle size={size} aria-hidden />;
    case 'warning': return <AlertTriangle size={size} aria-hidden />;
    case 'info': return <Info size={size} aria-hidden />;
    case 'skipped': case 'blocked': return <MinusCircle size={size} aria-hidden />;
    default: return <CircleDashed size={size} aria-hidden />;
  }
}

const RESULT_LABEL: Record<string, string> = { pass: 'Passed', fail: 'Failed', warning: 'Warning', info: 'Info', skipped: 'Not run', blocked: 'Blocked' };

type Filter = 'all' | 'fail' | 'warning' | 'pass' | 'notrun';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'fail', label: 'Failed' },
  { id: 'warning', label: 'Warnings' },
  { id: 'pass', label: 'Passed' },
  { id: 'notrun', label: 'Not run' },
];
const matches = (f: Filter, s: string) => f === 'all' || (f === 'notrun' ? s === 'skipped' || s === 'blocked' : f === 'pass' ? s === 'pass' || s === 'info' : s === f);
const ORDER: Record<string, number> = { fail: 0, warning: 1, blocked: 2, skipped: 3, info: 4, pass: 5 };

function EvidenceView({ ev }: { ev: Record<string, unknown> }) {
  const rows = Object.entries(ev).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!rows.length) return null;
  const show = (v: unknown): string => {
    if (typeof v === 'string') return v.length > 600 ? `${v.slice(0, 600)}…` : v;
    const s = JSON.stringify(v, null, 1) ?? '';
    return s.length > 800 ? `${s.slice(0, 800)}…` : s;
  };
  return (
    <dl className="kv">
      {rows.slice(0, 12).map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{typeof v === 'object' ? <pre className="code" style={{ margin: 0, fontSize: 'var(--fs-xs)' }}>{show(v)}</pre> : show(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ResultRow({ r, moduleLabel }: { r: ResultDTO; moduleLabel: string }) {
  const [open, setOpen] = useState(false);
  const { ask, job } = useBugsy();
  const rec = typeof r.evidence?.recommendation === 'string' ? (r.evidence.recommendation as string) : null;
  return (
    <li className="res">
      <button className="res-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`sic sic-${r.status}`}><StatusIcon k={r.status} /></span>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="res-title">{r.title}</span>
          <span className="res-msg" style={{ display: '-webkit-box', WebkitLineClamp: open ? 'unset' : 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{r.message}</span>
          <span className="res-meta">
            <span>{moduleLabel}</span>
            {r.affectedUrl && <span style={{ overflowWrap: 'anywhere' }}>{r.affectedUrl}</span>}
          </span>
        </span>
        <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          {r.severity && r.status !== 'pass' && r.status !== 'info' && r.status !== 'skipped' && <span className={`sev sev-${r.severity}`}>{r.severity}</span>}
          <span className={`st st-${r.status}`}>{RESULT_LABEL[r.status] ?? r.status}</span>
          <ChevronDown size={16} className={open ? 'rot' : ''} aria-hidden />
        </span>
      </button>
      {open && (
        <div className="res-body">
          <dl className="kv">
            <dt>Test</dt><dd>{moduleLabel} · {r.checkKey}</dd>
            {r.affectedUrl && (<><dt>Page / URL</dt><dd>{r.affectedUrl}</dd></>)}
            <dt>Result</dt><dd>{RESULT_LABEL[r.status] ?? r.status}{r.confidence ? ` · ${r.confidence}` : ''}</dd>
            <dt>Details</dt><dd>{r.message}</dd>
          </dl>
          {rec && <div className="fixbox"><b>Suggested fix. </b>{rec}</div>}
          <EvidenceView ev={Object.fromEntries(Object.entries(r.evidence ?? {}).filter(([k]) => k !== 'recommendation'))} />
          {(r.status === 'fail' || r.status === 'warning') && job && (
            <div><button className="btn btn-ghost btn-sm" onClick={() => ask(`Explain this problem and how to fix it: "${r.title}"${r.affectedUrl ? ` on ${r.affectedUrl}` : ''}. Where is it, why does it happen and what should I change?`)}><MessageCircle size={14} /> Ask BUGSY about this</button></div>
          )}
        </div>
      )}
    </li>
  );
}

interface Props {
  jobId: string;
  jobStatus: string;
  modules: ModuleStateDTO[];
  logs?: LogDTO[];
  live?: boolean;
}

/** The side panel (every test, its real state and counts) plus the results / log view for the chosen test. */
export function TestActivity({ jobId, jobStatus, modules, logs, live }: Props) {
  const [selected, setSelected] = useState<string>('all');
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<'results' | 'log'>('results');
  const [logModule, setLogModule] = useState<string>('all');
  const [results, setResults] = useState<ResultDTO[] | null>(null);
  const [error, setError] = useState(false);
  const logBox = useRef<HTMLDivElement>(null);

  // Refetch only when something real changed: a module settled, the job status moved or the result counts grew.
  const stamp = useMemo(
    () => `${jobStatus}|${modules.map((m) => `${m.status}:${m.counts.pass + m.counts.fail + m.counts.warning + m.counts.info + m.counts.skipped + m.counts.blocked}`).join(',')}`,
    [jobStatus, modules],
  );
  useEffect(() => {
    let dead = false;
    get<{ items: ResultDTO[] }>(`/api/tests/${jobId}/results`)
      .then((r) => { if (!dead) { setResults(r.items); setError(false); } })
      .catch(() => { if (!dead) setError(true); });
    return () => { dead = true; };
  }, [jobId, stamp]);

  const labelOf = useMemo(() => new Map(modules.map((m) => [m.moduleId, m.label])), [modules]);
  const selMod = modules.find((m) => m.moduleId === selected) ?? null;

  const totals = useMemo(() => {
    const t = { pass: 0, fail: 0, warning: 0, notrun: 0 };
    for (const m of modules) { t.pass += m.counts.pass; t.fail += m.counts.fail; t.warning += m.counts.warning; t.notrun += m.counts.skipped + m.counts.blocked; }
    return t;
  }, [modules]);

  const shown = useMemo(() => {
    const list = (results ?? []).filter((r) => (selected === 'all' || r.moduleId === selected) && matches(filter, r.status));
    return list.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  }, [results, selected, filter]);

  const shownLogs = useMemo(() => (logs ?? []).filter((l) => logModule === 'all' || l.moduleId === logModule), [logs, logModule]);
  useEffect(() => {
    if (view === 'log') logBox.current?.scrollTo({ top: logBox.current.scrollHeight });
  }, [shownLogs.length, view]);

  const settled = modules.filter((m) => ['completed', 'failed', 'skipped', 'blocked'].includes(m.status)).length;

  return (
    <div className="run-layout">
      <aside className="panel side" aria-label="Tests performed">
        <div className="panel-head">
          <h2>Tests performed</h2>
          <span className="small muted">{settled} of {modules.length} done</span>
        </div>
        <ul className="act-list">
          <li>
            <button className="act act-all" aria-current={selected === 'all'} onClick={() => { setSelected('all'); setView('results'); }}>
              <span className="grow"><span className="act-name">All tests</span><span className="act-sub">{totals.fail} failed · {totals.warning} warnings · {totals.pass} passed</span></span>
            </button>
          </li>
          {modules.map((m) => {
            const v = moduleVerdict(m);
            return (
              <li key={m.moduleId}>
                <button className="act" aria-current={selected === m.moduleId} onClick={() => { setSelected(m.moduleId); setView('results'); }}>
                  <span className={`sic sic-${v.key}`}><StatusIcon k={v.key} /></span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="act-name">{m.label}</span>
                    <span className="act-sub">{v.label}{m.durationMs != null && m.status !== 'pending' ? ` · ${formatDuration(m.durationMs)}` : ''}</span>
                  </span>
                  {(m.status === 'completed' || m.status === 'failed') && (
                    <span className="act-counts">
                      {m.counts.fail > 0 && <span className="count count-fail" title="Failed">{m.counts.fail}</span>}
                      {m.counts.warning > 0 && <span className="count count-warning" title="Warnings">{m.counts.warning}</span>}
                      {m.counts.pass > 0 && <span className="count count-pass" title="Passed">{m.counts.pass}</span>}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="panel" aria-label="Test results">
        <div className="panel-head">
          <div className="tabs" role="tablist" style={{ border: 0 }}>
            <button role="tab" aria-selected={view === 'results'} onClick={() => setView('results')}>Results</button>
            {logs && <button role="tab" aria-selected={view === 'log'} onClick={() => setView('log')}>Activity log</button>}
          </div>
          {live && <span className="st st-running"><Loader2 size={12} className="spin" aria-hidden /> Live</span>}
        </div>

        {view === 'results' ? (
          <>
            <div className="toolbar">
              <div className="seg" role="group" aria-label="Filter results">
                {FILTERS.map((f) => <button key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
              </div>
              <span className="small muted">{selMod ? selMod.label : 'All tests'} · {shown.length} {shown.length === 1 ? 'check' : 'checks'}</span>
            </div>
            {selMod && (selMod.errorMessage || selMod.note) && (
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                <div className={`notice ${selMod.status === 'failed' ? 'notice-error' : ''}`}><span>{selMod.errorMessage || selMod.note}</span></div>
              </div>
            )}
            {results === null && !error && <div className="empty-note">Loading results…</div>}
            {error && results === null && <div className="empty-note">Results could not be loaded. They will appear as soon as the connection recovers.</div>}
            {results !== null && shown.length === 0 && (
              <div className="empty-note">
                {selMod && (selMod.status === 'pending' || selMod.status === 'running') ? `${selMod.label} has not produced results yet.` : 'No checks match this filter.'}
              </div>
            )}
            <ul className="res-list res-scroll">{shown.map((r) => <ResultRow key={r.id} r={r} moduleLabel={labelOf.get(r.moduleId) ?? r.moduleId} />)}</ul>
          </>
        ) : (
          <>
            <div className="toolbar">
              <label className="small muted" htmlFor="log-mod">Test</label>
              <select id="log-mod" className="input" style={{ width: 'auto', minHeight: 32, padding: '4px 10px' }} value={logModule} onChange={(e) => setLogModule(e.target.value)}>
                <option value="all">All tests</option>
                {modules.map((m) => <option key={m.moduleId} value={m.moduleId}>{m.label}</option>)}
              </select>
              <span className="small muted">{shownLogs.length} entries</span>
            </div>
            <div className="logs" ref={logBox} role="log" aria-live="off" tabIndex={0}>
              {shownLogs.length === 0 && <div className="empty-note" style={{ color: '#94a3b8' }}>No log entries yet.</div>}
              {shownLogs.map((l) => (
                <div key={l.id} className={`logrow log-${l.level}`}>
                  <time>{new Date(l.createdAt).toLocaleTimeString([], { hour12: false })}</time>
                  <span className="lg-mod">{l.moduleId ? labelOf.get(l.moduleId) ?? l.moduleId : 'system'}</span>
                  <span className="lg-msg">{l.message}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
