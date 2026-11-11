import { ArrowRight } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, post } from '../lib/api';
import { ACTIVE_KEY, useAuth } from '../lib/auth';
import { guessUrl } from '../lib/format';
import { Spinner } from '../lib/ui';

export const PENDING_URL_KEY = 'nba.pendingUrl';

/** The URL box. Signed-out visitors are sent to sign up first and their URL is remembered for after sign-in. */
export function StartTestForm({ compact = false, autoFocus = false }: { compact?: boolean; autoFocus?: boolean }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const [url, setUrl] = useState(() => {
    try {
      return sessionStorage.getItem(PENDING_URL_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [ok, setOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const value = guessUrl(url);
    if (!value) return setError('Please enter a valid website URL.');
    if (!ok) return setError('Please confirm you are authorised to test this website.');
    if (!user) {
      try {
        sessionStorage.setItem(PENDING_URL_KEY, value);
      } catch {
        /* storage unavailable: the user simply re-enters the URL */
      }
      nav('/signup', { state: { next: '/dashboard' } });
      return;
    }
    setBusy(true);
    try {
      const r = await post<{ job: { id: string } }>('/api/tests', { url: value, authorizationConfirmed: true, idempotencyKey: crypto.randomUUID() });
      try {
        sessionStorage.removeItem(PENDING_URL_KEY);
        localStorage.setItem(ACTIVE_KEY, r.job.id);
      } catch {
        /* storage unavailable */
      }
      nav(`/tests/${r.job.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="stack" style={{ ['--gap' as string]: '12px' }}>
      <div className={compact ? 'row' : 'url-box'} style={{ flexWrap: 'nowrap' }}>
        <label htmlFor="site-url" className="sr-only">Website URL</label>
        <input id="site-url" className="input url-input" inputMode="url" autoComplete="url" spellCheck={false} autoFocus={autoFocus} placeholder="Enter your website URL (https://example.com)" value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? 'site-url-err' : undefined} />
        <button className="btn btn-yellow url-go" disabled={busy}>
          {busy ? <Spinner label="Starting" /> : <>Start Testing <ArrowRight size={18} /></>}
        </button>
      </div>
      <label className="check small">
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
        <span>I own this website or have permission to test it. Tests are passive and non-destructive.</span>
      </label>
      {error && <p id="site-url-err" className="field-error" role="alert">{error}</p>}
    </form>
  );
}
