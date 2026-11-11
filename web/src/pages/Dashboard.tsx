import { motion } from 'framer-motion';
import { ArrowRight, History, Radio } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { JobDTO } from '@nba/shared';
import { Mascot } from '../components/Mascot';
import { StartTestForm } from '../components/StartTestForm';
import { ApiError, get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, pluralise, STATUS_LABEL, timeAgo } from '../lib/format';
import { Notice, PageLoader, useDocumentTitle, useInterval } from '../lib/ui';

const PAGE_SIZE = 10;

export default function Dashboard() {
  useDocumentTitle('Dashboard');
  const { user } = useAuth();
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<JobDTO[] | null>(null);
  const [total, setTotal] = useState(0);
  const [active, setActive] = useState<JobDTO[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    get<{ items: JobDTO[]; total: number }>(`/api/tests?page=${page}&pageSize=${PAGE_SIZE}`)
      .then((r) => { setItems(r.items); setTotal(r.total); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load your tests.'));
    get<{ items: JobDTO[] }>('/api/tests/active').then((r) => setActive(r.items)).catch(() => undefined);
  };
  useEffect(load, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  useInterval(load, active.length > 0 ? 5000 : null);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const first = user?.fullName?.split(' ')[0] || 'there';

  return (
    <div className="wrap page">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="stack" style={{ ['--gap' as string]: '10px' }}>
        <h1 style={{ fontSize: 'clamp(1.8rem,4vw,2.6rem)' }}>Hi {first}, ready to squash some bugs?</h1>
        <p className="muted">Start a new test, or reopen one of your reports.</p>
      </motion.div>

      <div className="card card-butter" style={{ padding: 22, marginTop: 22, maxWidth: 760 }}><StartTestForm compact /></div>

      {active.length > 0 && (
        <section style={{ marginTop: 30 }} aria-label="Tests in progress">
          <h2 style={{ fontSize: '1.3rem', marginBottom: 12 }} className="row"><Radio size={20} /> In progress</h2>
          <ul className="issues">
            {active.map((j) => (
              <li key={j.id} className="card row spread" style={{ padding: '14px 18px' }}>
                <span><b>{j.hostname}</b> <span className="muted small">· {STATUS_LABEL[j.status]} · {j.progressPct}%</span></span>
                <Link className="btn btn-yellow btn-sm" to={`/tests/${j.id}`}>Continue watching <ArrowRight size={15} /></Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={{ marginTop: 34 }} aria-label="Test history">
        <h2 style={{ fontSize: '1.3rem', marginBottom: 12 }} className="row"><History size={20} /> Test history</h2>
        {error && <Notice kind="error">{error}</Notice>}
        {!items && !error && <PageLoader label="Loading your tests" />}
        {items && items.length === 0 && (
          <div className="card empty"><Mascot size={100} /><h3>No tests yet</h3><p className="muted">Enter a website above to run your first test.</p></div>
        )}
        {items && items.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Website</th><th>Status</th><th>Result</th><th>When</th><th /></tr></thead>
                <tbody>
                  {items.map((j) => (
                    <tr key={j.id}>
                      <td><b style={{ wordBreak: 'break-all' }}>{j.hostname}</b></td>
                      <td>{STATUS_LABEL[j.status] ?? j.status}</td>
                      <td>{j.summary ? (j.summary.bugs > 0 ? pluralise(j.summary.bugs, 'issue') : 'No issues detected') : '—'}{j.summary?.incomplete ? <span className="small muted"> (partial)</span> : null}</td>
                      <td title={formatDate(j.queuedAt)}>{timeAgo(j.finishedAt ?? j.queuedAt)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Link className="btn btn-sm btn-ghost" to={j.status === 'queued' || j.status === 'running' ? `/tests/${j.id}` : `/reports/${j.id}`}>{j.status === 'queued' || j.status === 'running' ? 'Watch' : 'Open report'}</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="row spread" style={{ marginTop: 14 }}>
                <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
                <span className="small muted">Page {page} of {pages}</span>
                <button className="btn btn-ghost btn-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
