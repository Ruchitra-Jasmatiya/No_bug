import { motion } from 'framer-motion';
import { Activity, BarChart3, Check, FileClock, Mail, Settings, ShieldAlert, TestTube2, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { BarList, Columns, Legend, SeverityDonut } from '../components/Charts';
import { ApiError, get, patch, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDuration, timeAgo } from '../lib/format';
import { Notice, PageLoader, useDocumentTitle, useToast } from '../lib/ui';

const TABS = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'tests', label: 'Tests', icon: TestTube2 },
  { id: 'security', label: 'Security', icon: ShieldAlert },
  { id: 'audit', label: 'Audit log', icon: FileClock },
  { id: 'emails', label: 'Emails', icon: Mail },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'system', label: 'System', icon: Activity },
] as const;
type Tab = (typeof TABS)[number]['id'];

function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setError(null);
    get<T>(path).then((d) => alive && setData(d)).catch((e) => alive && setError(e instanceof ApiError ? e.message : 'Could not load data.'));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'bad' }) {
  return (
    <div className="card card-flat" style={{ padding: 18, borderColor: tone === 'bad' ? 'var(--sev-critical)' : undefined }}>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '2rem', lineHeight: 1.1 }}>{value}</div>
      <div className="small muted">{label}</div>
    </div>
  );
}

function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="row spread" style={{ marginTop: 12 }}>
      <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span className="small muted">Page {page} of {pages} · {total} total</span>
      <button className="btn btn-ghost btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}

const Table = ({ head, children, empty }: { head: string[]; children: ReactNode[]; empty: string }) => (
  <div className="table-wrap">
    <table className="table">
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{children.length ? children : <tr><td colSpan={head.length} className="muted" style={{ textAlign: 'center', padding: 28 }}>{empty}</td></tr>}</tbody>
    </table>
  </div>
);

const Err = ({ msg }: { msg: string | null }) => (msg ? <Notice kind="error">{msg}</Notice> : null);

/* ---------------------------------------------------------------- overview */
function Overview() {
  const o = useLoad<any>('/api/admin/overview');
  const a = useLoad<any>('/api/admin/analytics?days=14');
  if (o.error || a.error) return <Err msg={o.error ?? a.error} />;
  if (!o.data || !a.data) return <PageLoader label="Loading overview" />;
  const d = o.data;
  return (
    <div className="stack" style={{ ['--gap' as string]: '22px' }}>
      <div className="admin-stats">
        <Stat label="Users" value={d.users.total} />
        <Stat label="New (7 days)" value={d.users.newLast7Days} />
        <Stat label="Suspended" value={d.users.suspended} />
        <Stat label="Tests run" value={d.tests.total} />
        <Stat label="Running now" value={d.tests.active} />
        <Stat label="Failed tests" value={d.tests.failed} />
        <Stat label="Issues found" value={d.bugs.total} />
        <Stat label="Open high alerts" value={d.security.openHighAlerts} tone={d.security.openHighAlerts > 0 ? 'bad' : undefined} />
        <Stat label="Failed logins (24 h)" value={d.security.failedLogins24h} />
        <Stat label="Emails failed (24 h)" value={d.emails.failedLast24h} tone={d.emails.failedLast24h > 0 ? 'bad' : undefined} />
      </div>
      <div className="admin-grid">
        <section className="card"><h3 style={{ marginBottom: 12 }}>Tests per day</h3>
          <Columns data={a.data.testsPerDay} series={[{ key: 'completed', color: 'var(--sage)', label: 'Completed' }, { key: 'failed', color: 'var(--sev-critical)', label: 'Failed' }]} />
        </section>
        <section className="card"><h3 style={{ marginBottom: 12 }}>Sign-ups per day</h3>
          <Columns data={a.data.signupsPerDay} series={[{ key: 'n', color: 'var(--butter-deep)', label: 'New users' }]} />
        </section>
        <section className="card"><h3 style={{ marginBottom: 12 }}>Issues by severity (14 days)</h3>
          <div className="row" style={{ gap: 20, justifyContent: 'center' }}><SeverityDonut counts={a.data.severity} /><Legend counts={a.data.severity} /></div>
        </section>
        <section className="card"><h3 style={{ marginBottom: 12 }}>Top categories</h3>
          <BarList items={a.data.topCategories.map((c: any) => ({ label: c.category, value: c.count }))} />
          <p className="small muted" style={{ marginTop: 12 }}>Average test duration: {a.data.avgDurationSeconds ? formatDuration(a.data.avgDurationSeconds * 1000) : 'no completed tests yet'}</p>
        </section>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- users */
function UsersTab() {
  const { user: me } = useAuth();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, error, reload } = useLoad<any>(`/api/admin/users?page=${page}&pageSize=20&search=${encodeURIComponent(q)}&status=${status}`);
  useEffect(() => { const t = setTimeout(() => { setQ(search); setPage(1); }, 350); return () => clearTimeout(t); }, [search]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast(ok); reload(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Action failed.', 'error'); }
  }
  return (
    <div className="stack">
      <div className="row">
        <input className="input" style={{ maxWidth: 320 }} placeholder="Search name or email" aria-label="Search users" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" style={{ maxWidth: 180 }} aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option>
        </select>
      </div>
      <Err msg={error} />
      {!data ? <PageLoader /> : (
        <>
          <Table head={['User', 'Status', 'Role', 'Tests', 'Last login', 'Joined', 'Actions']} empty="No users match.">
            {data.items.map((u: any) => (
              <tr key={u.id}>
                <td><b>{u.fullName || '—'}</b><div className="small muted">{u.email}{!u.verified && ' · unverified'}</div></td>
                <td><span className={`tag ${u.status === 'suspended' ? 'tag-bad' : ''}`}>{u.status}</span></td>
                <td>{u.role}</td><td>{u.tests}</td><td>{u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'never'}</td><td>{formatDate(u.createdAt)}</td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    {u.id !== me?.id && (u.status === 'active'
                      ? <button className="btn btn-sm btn-danger" onClick={() => { const reason = window.prompt('Reason for suspending (optional):') ; if (reason !== null) void act(() => patch(`/api/admin/users/${u.id}/status`, { status: 'suspended', reason: reason || undefined }), 'User suspended.'); }}>Suspend</button>
                      : <button className="btn btn-sm" onClick={() => void act(() => patch(`/api/admin/users/${u.id}/status`, { status: 'active' }), 'User reactivated.')}>Reactivate</button>)}
                    {u.id !== me?.id && <button className="btn btn-sm btn-ghost" onClick={() => { if (window.confirm(`Make ${u.email} ${u.role === 'admin' ? 'a regular user' : 'an admin'}?`)) void act(() => patch(`/api/admin/users/${u.id}/role`, { role: u.role === 'admin' ? 'user' : 'admin' }), 'Role updated.'); }}>{u.role === 'admin' ? 'Remove admin' : 'Make admin'}</button>}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- tests */
function TestsTab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const { data, error } = useLoad<any>(`/api/admin/tests?page=${page}&pageSize=20&status=${status}`);
  return (
    <div className="stack">
      <select className="input" style={{ maxWidth: 200 }} aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
        <option value="">All statuses</option>{['queued', 'running', 'completed', 'failed', 'cancelled'].map((s) => <option key={s}>{s}</option>)}
      </select>
      <Err msg={error} />
      {!data ? <PageLoader /> : (
        <>
          <Table head={['Website', 'User', 'Status', 'Progress', 'Issues', 'Created', 'Error']} empty="No tests yet.">
            {data.items.map((t: any) => (
              <tr key={t.id}><td><b style={{ wordBreak: 'break-all' }}>{t.hostname}</b></td><td className="small">{t.userEmail}</td><td>{t.status}</td><td>{t.progressPct}%</td><td>{t.bugs ?? '—'}</td><td>{formatDate(t.createdAt)}</td><td className="small muted">{t.errorMessage ?? ''}</td></tr>
            ))}
          </Table>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- security */
function SecurityTab() {
  const toast = useToast();
  const [ack, setAck] = useState('false');
  const [ePage, setEPage] = useState(1);
  const [lPage, setLPage] = useState(1);
  const [success, setSuccess] = useState('');
  const ev = useLoad<any>(`/api/admin/security/events?page=${ePage}&pageSize=10&acknowledged=${ack}`);
  const lg = useLoad<any>(`/api/admin/security/logins?page=${lPage}&pageSize=15&success=${success}`);
  async function acknowledge(id: string) {
    try { await post(`/api/admin/security/events/${id}/acknowledge`); toast('Alert acknowledged.'); ev.reload(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Failed.', 'error'); }
  }
  return (
    <div className="stack" style={{ ['--gap' as string]: '30px' }}>
      <section className="stack">
        <div className="row spread"><h3>Security alerts</h3>
          <select className="input" style={{ maxWidth: 190 }} aria-label="Alert filter" value={ack} onChange={(e) => { setAck(e.target.value); setEPage(1); }}><option value="false">Unacknowledged</option><option value="true">Acknowledged</option><option value="">All</option></select>
        </div>
        <Err msg={ev.error} />
        {!ev.data ? <PageLoader /> : (
          <>
            <Table head={['When', 'Kind', 'Risk', 'Email', 'Attempts', 'IP', 'Action taken', '']} empty="No alerts. Failed-login bursts above the threshold appear here.">
              {ev.data.items.map((e: any) => (
                <tr key={e.id}><td>{formatDate(e.createdAt)}</td><td>{e.kind}</td><td><span className={`tag ${e.riskLevel === 'high' || e.riskLevel === 'critical' ? 'tag-bad' : 'tag-warn'}`}>{e.riskLevel}</span></td><td className="small">{e.email ?? '—'}</td><td>{e.attemptCount ?? '—'}</td><td className="mono small">{e.ip ?? '—'}</td><td className="small">{e.actionTaken ?? '—'}</td>
                  <td>{e.acknowledged ? <span className="tag"><Check size={13} /> done</span> : <button className="btn btn-sm" onClick={() => acknowledge(e.id)}>Acknowledge</button>}</td></tr>
              ))}
            </Table>
            <Pager page={ev.data.page} pageSize={ev.data.pageSize} total={ev.data.total} onPage={setEPage} />
          </>
        )}
      </section>
      <section className="stack">
        <div className="row spread"><h3>Login attempts</h3>
          <select className="input" style={{ maxWidth: 170 }} aria-label="Login filter" value={success} onChange={(e) => { setSuccess(e.target.value); setLPage(1); }}><option value="">All</option><option value="false">Failed</option><option value="true">Successful</option></select>
        </div>
        <Err msg={lg.error} />
        {!lg.data ? <PageLoader /> : (
          <>
            <Table head={['When', 'Email', 'Result', 'Reason', 'IP', 'Browser']} empty="No login attempts recorded.">
              {lg.data.items.map((l: any) => (
                <tr key={l.id}><td>{formatDate(l.createdAt)}</td><td className="small">{l.email}</td><td><span className={`tag ${l.success ? '' : 'tag-bad'}`}>{l.success ? 'success' : 'failed'}</span></td><td className="small">{l.reason ?? ''}</td><td className="mono small">{l.ip ?? ''}</td><td className="small muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.userAgent ?? ''}</td></tr>
              ))}
            </Table>
            <Pager page={lg.data.page} pageSize={lg.data.pageSize} total={lg.data.total} onPage={setLPage} />
          </>
        )}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- audit + emails */
function AuditTab() {
  const [page, setPage] = useState(1);
  const { data, error } = useLoad<any>(`/api/admin/audit-logs?page=${page}&pageSize=25`);
  return (
    <div className="stack"><Err msg={error} />{!data ? <PageLoader /> : (<>
      <Table head={['When', 'Actor', 'Action', 'Target', 'Details', 'IP']} empty="Nothing logged yet.">
        {data.items.map((a: any) => <tr key={a.id}><td>{formatDate(a.createdAt)}</td><td className="small">{a.actorEmail ?? 'system'}</td><td><b>{a.action}</b></td><td className="small">{a.targetType}{a.targetId ? ` ${String(a.targetId).slice(0, 8)}…` : ''}</td><td className="mono small" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>{JSON.stringify(a.metadata)}</td><td className="mono small">{a.ip ?? ''}</td></tr>)}
      </Table>
      <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>)}</div>
  );
}

function EmailsTab() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const { data, error } = useLoad<any>(`/api/admin/emails?page=${page}&pageSize=25&status=${status}`);
  return (
    <div className="stack">
      <select className="input" style={{ maxWidth: 180 }} aria-label="Email status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All</option><option>sent</option><option>failed</option><option>pending</option></select>
      <p className="small muted">Only the recipient, template and delivery status are stored. Message bodies (and one-time codes) are never saved.</p>
      <Err msg={error} />{!data ? <PageLoader /> : (<>
        <Table head={['When', 'To', 'Template', 'Subject', 'Status', 'Error']} empty="No emails yet.">
          {data.items.map((m: any) => <tr key={m.id}><td>{formatDate(m.createdAt)}</td><td className="small">{m.to}</td><td className="small">{m.template}</td><td className="small">{m.subject}</td><td><span className={`tag ${m.status === 'failed' ? 'tag-bad' : ''}`}>{m.status}</span></td><td className="small muted">{m.error ?? ''}</td></tr>)}
        </Table>
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></>)}
    </div>
  );
}

/* ---------------------------------------------------------------- settings */
function SettingRow({ s, onSaved }: { s: { key: string; value: unknown; description: string }; onSaved: () => void }) {
  const toast = useToast();
  const [text, setText] = useState(JSON.stringify(s.value, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(JSON.stringify(s.value, null, 2)), [s.value]);
  const dirty = text !== JSON.stringify(s.value, null, 2);
  async function save() {
    setError(null);
    let value: unknown;
    try { value = JSON.parse(text); } catch { return setError('This is not valid JSON.'); }
    setBusy(true);
    try { await put(`/api/admin/settings/${s.key}`, { value }); toast(`Saved “${s.key}”.`); onSaved(); } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not save.'); } finally { setBusy(false); }
  }
  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="row spread"><b className="mono">{s.key}</b><button className="btn btn-sm btn-yellow" disabled={!dirty || busy} onClick={save}>Save</button></div>
      <p className="small muted" style={{ margin: '4px 0 10px' }}>{s.description}</p>
      <textarea className="input mono" rows={Math.min(10, text.split('\n').length + 1)} value={text} onChange={(e) => setText(e.target.value)} aria-label={`Value of ${s.key}`} spellCheck={false} />
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}
function SettingsTab() {
  const { data, error, reload } = useLoad<any>('/api/admin/settings');
  return (
    <div className="stack"><Notice>Settings take effect immediately. Secrets (API keys, passwords) cannot be stored here; they live in server environment variables.</Notice><Err msg={error} />
      {!data ? <PageLoader /> : <div className="stack" style={{ ['--gap' as string]: '14px' }}>{data.items.map((s: any) => <SettingRow key={s.key} s={s} onSaved={reload} />)}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- system */
function SystemTab() {
  const { data, error } = useLoad<any>('/api/admin/system');
  if (error) return <Err msg={error} />;
  if (!data) return <PageLoader />;
  const row = (label: string, ok: boolean, detail?: string) => (
    <div className="card card-flat row spread" style={{ padding: '12px 16px' }}><span>{label}</span><span className={`tag ${ok ? '' : 'tag-bad'}`}>{ok ? 'OK' : 'Needs attention'}{detail ? ` · ${detail}` : ''}</span></div>
  );
  return (
    <div className="stack" style={{ ['--gap' as string]: '10px', maxWidth: 640 }}>
      {row('Database', data.database)}
      {row('Redis / queue', data.redis)}
      {row('Test runners', data.queue.activeWorkers > 0, `${data.queue.activeWorkers} live`)}
      {row('Stuck tests', data.queue.staleRunning === 0 && data.queue.waitingOverTwoMinutes === 0, `${data.queue.queued} queued · ${data.queue.running} running`)}
      {row('AI provider configured', data.ai.configured, data.ai.configured ? '' : 'BUGSY chat and explanations disabled')}
      {row('Email provider configured', data.email.configured)}
      {row('Admin alert email configured', data.adminAlertEmailConfigured, data.adminAlertEmailConfigured ? '' : 'set ADMIN_NOTIFICATION_EMAIL')}
      <p className="small muted">Auth provider: {data.authProvider}</p>
    </div>
  );
}

export default function Admin() {
  useDocumentTitle('Admin');
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <div className="wrap page">
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}>
        <h1 style={{ fontSize: 'clamp(1.8rem,4vw,2.6rem)' }}>Admin console</h1>
        <p className="muted">Real data from your database. Every change here is written to the audit log.</p>
      </motion.div>
      <div className="tabs" role="tablist" style={{ marginTop: 18 }}>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}><span className="row" style={{ gap: 7, flexWrap: 'nowrap' }}><t.icon size={16} aria-hidden />{t.label}</span></button>
        ))}
      </div>
      <div role="tabpanel" style={{ marginTop: 24 }}>
        {tab === 'overview' && <Overview />}
        {tab === 'users' && <UsersTab />}
        {tab === 'tests' && <TestsTab />}
        {tab === 'security' && <SecurityTab />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'emails' && <EmailsTab />}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'system' && <SystemTab />}
      </div>
    </div>
  );
}
