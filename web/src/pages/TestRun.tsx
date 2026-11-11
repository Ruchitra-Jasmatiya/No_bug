import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Check, ChevronDown, CircleDashed, Clock, Loader2, MinusCircle, RotateCw, Square, WifiOff, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { LogDTO, ModuleStateDTO, ProgressDTO } from '@nba/shared';
import { Mascot } from '../components/Mascot';
import { ApiError, get, post } from '../lib/api';
import { ACTIVE_KEY } from '../lib/auth';
import { useBugsy } from '../lib/bugsy';
import { formatDuration, STATUS_LABEL } from '../lib/format';
import { Modal, Notice, PageLoader, Spinner, useDocumentTitle, useToast } from '../lib/ui';

const POLL_MS = 1500;
const ACTIVE = new Set(['queued', 'running']);

function remember(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* storage unavailable */
  }
}

function ModuleIcon({ status }: { status: string }) {
  if (status === 'running') return <Loader2 size={18} className="spin" aria-hidden />;
  if (status === 'completed') return <Check size={18} aria-hidden />;
  if (status === 'failed') return <AlertTriangle size={18} aria-hidden />;
  if (status === 'skipped' || status === 'blocked') return <MinusCircle size={18} aria-hidden />;
  return <CircleDashed size={18} aria-hidden />;
}

function ModuleRow({ m }: { m: ModuleStateDTO }) {
  const [open, setOpen] = useState(false);
  const c = m.counts;
  const detail = m.errorMessage || m.note;
  const expandable = true;
  return (
    <li className={`mod mod-${m.status}`}>
      <button className="mod-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!expandable}>
        <span className="mod-icon"><ModuleIcon status={m.status} /></span>
        <span className="grow" style={{ textAlign: 'left' }}>
          <b>{m.label}</b>
          <span className="small muted" style={{ display: 'block' }}>
            {STATUS_LABEL[m.status] ?? m.status}
            {m.durationMs != null && m.status !== 'pending' ? ` · ${formatDuration(m.durationMs)}` : ''}
          </span>
        </span>
        {m.status !== 'pending' && m.status !== 'running' && (
          <span className="row small" style={{ gap: 6, flexWrap: 'nowrap' }}>
            {c.fail > 0 && <span className="tag tag-bad">{c.fail} failed</span>}
            {c.warning > 0 && <span className="tag tag-warn">{c.warning} warn</span>}
            {c.pass > 0 && <span className="tag">{c.pass} passed</span>}
          </span>
        )}
        <ChevronDown size={18} className={open ? 'rot' : ''} aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} style={{ overflow: 'hidden' }}>
            <div className="mod-body small">
              {detail ? <p style={{ margin: 0 }}>{detail}</p> : <p className="muted" style={{ margin: 0 }}>{m.status === 'pending' ? 'Waiting for its turn.' : m.status === 'running' ? 'Running now…' : 'Finished with no extra notes.'}</p>}
              <p className="muted" style={{ margin: '6px 0 0' }}>
                Checks: {c.pass} passed · {c.fail} failed · {c.warning} warnings · {c.info} info{c.skipped + c.blocked ? ` · ${c.skipped + c.blocked} not run` : ''}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

export default function TestRun() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { setJob, setOpen } = useBugsy();
  const [data, setData] = useState<ProgressDTO | null>(null);
  const [logs, setLogs] = useState<LogDTO[]>([]);
  const [offline, setOffline] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const cursor = useRef(0);
  const failures = useRef(0);
  const logBox = useRef<HTMLDivElement>(null);
  useDocumentTitle(data ? `Testing ${data.job.hostname}` : 'Testing');

  const status = data?.job.status;
  const active = status ? ACTIVE.has(status) : true;

  const poll = useCallback(async () => {
    try {
      const p = await get<ProgressDTO>(`/api/tests/${id}/progress?after=${cursor.current}`);
      failures.current = 0;
      setOffline(false);
      cursor.current = p.logCursor;
      setData(p);
      if (p.logs.length) setLogs((l) => [...l, ...p.logs].slice(-400));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
        remember(null);
        setFatal('We could not find this test. It may belong to a different account.');
        return;
      }
      failures.current++;
      setOffline(true); // progress is stored on the server; we simply keep trying
    }
  }, [id]);

  useEffect(() => {
    cursor.current = 0;
    setLogs([]);
    setData(null);
    setFatal(null);
    void poll();
  }, [id, poll]);

  // Poll quickly while running, back off while offline, stop once finished.
  useEffect(() => {
    if (fatal || (data && !active)) return;
    const delay = offline ? Math.min(15000, POLL_MS * 2 ** Math.min(failures.current, 4)) : POLL_MS;
    const t = setTimeout(() => void poll(), delay);
    return () => clearTimeout(t);
  }, [data, active, offline, fatal, poll]);

  // Come back to a tab / network: refresh immediately.
  useEffect(() => {
    const kick = () => void poll();
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', kick);
    return () => {
      window.removeEventListener('online', kick);
      document.removeEventListener('visibilitychange', kick);
    };
  }, [poll]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Keep the "active test" pointer so a refresh / reopened browser can come back here.
  useEffect(() => {
    if (!data) return;
    remember(active ? id : null);
    const j = data.job;
    setJob({ jobId: j.id, hostname: j.hostname, status: j.status, bugs: j.summary?.bugs ?? 0, critical: 0, high: 0, incomplete: j.summary?.incomplete ?? false });
  }, [data, active, id, setJob]);

  useEffect(() => () => setJob(null), [setJob]);

  useEffect(() => {
    logBox.current?.scrollTo({ top: logBox.current.scrollHeight });
  }, [logs.length]);

  // Finished: go to the report.
  useEffect(() => {
    if (status === 'completed') {
      const t = setTimeout(() => nav(`/reports/${id}`, { replace: true }), 1400);
      return () => clearTimeout(t);
    }
  }, [status, id, nav]);

  // ---- refresh protection --------------------------------------------------------------------------
  // Browsers do not allow a custom dialog on reload, so: (1) F5 / Ctrl+R are intercepted and shown as our modal,
  // (2) closing the tab or other reloads get the browser's own "leave site?" prompt.
  const guard = useRef(true);
  useEffect(() => {
    if (!active || !data) return;
    guard.current = true;
    const onBefore = (e: BeforeUnloadEvent) => {
      if (!guard.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    const onKey = (e: KeyboardEvent) => {
      const reload = e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r');
      if (reload) {
        e.preventDefault();
        setConfirm(true);
      }
    };
    window.addEventListener('beforeunload', onBefore);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('beforeunload', onBefore);
      window.removeEventListener('keydown', onKey);
    };
  }, [active, data]);

  const continueTesting = () => {
    guard.current = false;
    window.location.reload(); // the test keeps running on the server; this page restores its progress
  };
  const startAgain = async () => {
    setBusy('restart');
    try {
      const r = await post<{ job: { id: string } }>(`/api/tests/${id}/restart`);
      guard.current = false;
      remember(r.job.id);
      setConfirm(false);
      nav(`/tests/${r.job.id}`, { replace: true });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not restart the test.', 'error');
    } finally {
      setBusy(null);
    }
  };
  const cancel = async () => {
    setBusy('cancel');
    try {
      await post(`/api/tests/${id}/cancel`);
      toast('Cancelling… the test stops at its next safe point.');
      void poll();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not cancel.', 'error');
    } finally {
      setBusy(null);
    }
  };
  const resume = async () => {
    setBusy('resume');
    try {
      await post(`/api/tests/${id}/resume`);
      toast('Resuming from the last saved checkpoint.');
      failures.current = 0;
      void poll();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not resume.', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (fatal) {
    return (
      <div className="wrap-narrow page">
        <div className="empty"><Mascot size={110} mood="alert" /><h1 style={{ fontSize: '2rem' }}>Test not found</h1><p className="muted">{fatal}</p><Link className="btn btn-yellow" to="/dashboard">Go to dashboard</Link></div>
      </div>
    );
  }
  if (!data) return <PageLoader label={offline ? 'Reconnecting' : 'Loading your test'} />;

  const j = data.job;
  const started = j.startedAt ? new Date(j.startedAt).getTime() : new Date(j.queuedAt).getTime();
  const end = j.finishedAt ? new Date(j.finishedAt).getTime() : now;
  const total = data.counts;
  const done = data.modules.filter((m) => ['completed', 'failed', 'skipped', 'blocked'].includes(m.status)).length;
  const mood = j.status === 'completed' ? 'happy' : j.status === 'failed' ? 'alert' : 'thinking';

  return (
    <div className="wrap page">
      <AnimatePresence>
        {offline && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} style={{ marginBottom: 16 }}>
            <Notice kind="error"><WifiOff size={0} aria-hidden />Connection interrupted. Your test progress is saved. Reconnecting…</Notice>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="run-head card card-butter">
        <Mascot size={92} mood={mood} />
        <div className="grow stack" style={{ ['--gap' as string]: '8px' }}>
          <p className="label muted" style={{ margin: 0 }}>{STATUS_LABEL[j.status]}</p>
          <h1 style={{ fontSize: 'clamp(1.5rem,3.6vw,2.2rem)', wordBreak: 'break-all' }}>{j.hostname}</h1>
          <div className="row small" style={{ gap: 16 }}>
            <span className="row" style={{ gap: 6 }}><Clock size={15} /> {formatDuration(Math.max(0, end - started))}</span>
            <span>{done}/{data.modules.length} modules</span>
            <span>{total.pass} passed · {total.fail} failed · {total.warning} warnings</span>
          </div>
        </div>
        <div className="stack" style={{ ['--gap' as string]: '8px', minWidth: 150 }}>
          {active && <button className="btn btn-ghost" onClick={cancel} disabled={busy === 'cancel' || j.cancelRequested}><Square size={16} /> {j.cancelRequested ? 'Cancelling…' : 'Cancel test'}</button>}
          {j.status === 'failed' && <button className="btn btn-yellow" onClick={resume} disabled={busy === 'resume'}><RotateCw size={16} /> Resume test</button>}
          {(j.status === 'failed' || j.status === 'cancelled') && <button className="btn btn-ghost" onClick={startAgain} disabled={busy === 'restart'}>Start again</button>}
          {j.status === 'cancelled' && data.modules.some((m) => m.status === 'completed') && <Link className="btn btn-ghost" to={`/reports/${id}`}>View partial report</Link>}
        </div>
      </div>

      <div style={{ margin: '22px 0' }}>
        <div className="row spread small" style={{ marginBottom: 6 }}><b>{j.status === 'queued' ? 'Waiting for a free test runner…' : j.status === 'completed' ? 'Finished' : 'Progress'}</b><b>{j.progressPct}%</b></div>
        <div className="progress" role="progressbar" aria-valuenow={j.progressPct} aria-valuemin={0} aria-valuemax={100} aria-label="Test progress"><i style={{ width: `${j.progressPct}%` }} /></div>
        {active && <p className="small muted" style={{ marginTop: 8 }}>You can leave this page. The test keeps running and your progress is saved; come back any time from the dashboard.</p>}
      </div>

      {j.status === 'failed' && <Notice kind="error">{j.errorMessage ?? 'This test could not be completed.'} Finished modules are saved, so resuming will not repeat them.</Notice>}
      {j.status === 'completed' && <Notice kind="ok">Test finished. Opening your report… <Link to={`/reports/${id}`}>Open now</Link></Notice>}

      <div className="run-grid">
        <section aria-label="Modules">
          <h2 style={{ fontSize: '1.3rem', marginBottom: 12 }}>What’s being tested</h2>
          <ul className="mods">{data.modules.map((m) => <ModuleRow key={m.moduleId} m={m} />)}</ul>
        </section>
        <section aria-label="Live log">
          <div className="row spread"><h2 style={{ fontSize: '1.3rem', marginBottom: 12 }}>Live log</h2>{active && <Spinner label="Live" />}</div>
          <div className="logbox mono" ref={logBox} role="log" aria-live="off" tabIndex={0}>
            {logs.length === 0 && <span className="muted">Waiting for the first message…</span>}
            {logs.map((l) => (
              <div key={l.id} className={`log log-${l.level}`}>
                <time>{new Date(l.createdAt).toLocaleTimeString()}</time> {l.message}
              </div>
            ))}
          </div>
          {active && <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>Ask BUGSY while you wait</button>}
        </section>
      </div>

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Your test is still running">
        <p>Refreshing is safe: the test runs on our servers and your progress is saved. You can carry on, or throw this run away and begin a new one.</p>
        <div className="stack" style={{ ['--gap' as string]: '10px', marginTop: 16 }}>
          <button className="btn btn-yellow" onClick={continueTesting}><RotateCw size={16} /> Continue Testing</button>
          <button className="btn btn-ghost" onClick={startAgain} disabled={busy === 'restart'}>{busy === 'restart' ? <Spinner label="Restarting" /> : 'Start Again'}</button>
          <button className="btn btn-ghost" onClick={() => setConfirm(false)}><X size={16} /> Stay Here</button>
        </div>
      </Modal>
    </div>
  );
}
