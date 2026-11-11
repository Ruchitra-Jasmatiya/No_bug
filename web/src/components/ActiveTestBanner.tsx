import { Radio } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { JobDTO } from '@nba/shared';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Restores a running test after a refresh, a closed tab or a new browser session: the server is asked for the
 * user's unfinished tests, so this works on any device, not just where the test was started.
 */
export function ActiveTestBanner() {
  const { user } = useAuth();
  const loc = useLocation();
  const [active, setActive] = useState<JobDTO | null>(null);

  useEffect(() => {
    if (!user) return setActive(null);
    let alive = true;
    const load = () => get<{ items: JobDTO[] }>('/api/tests/active').then((r) => alive && setActive(r.items[0] ?? null)).catch(() => undefined);
    void load();
    const t = setInterval(load, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [user, loc.pathname]);

  if (!user || !active || loc.pathname === `/tests/${active.id}`) return null;
  return (
    <div className="active-banner" role="status">
      <div className="wrap row spread" style={{ gap: 12 }}>
        <span className="row" style={{ gap: 10 }}><Radio size={18} aria-hidden /> A test of <b>{active.hostname}</b> is {active.status === 'queued' ? 'waiting to start' : `running (${active.progressPct}%)`}.</span>
        <Link className="btn btn-sm btn-yellow" to={`/tests/${active.id}`}>Continue watching</Link>
      </div>
    </div>
  );
}
