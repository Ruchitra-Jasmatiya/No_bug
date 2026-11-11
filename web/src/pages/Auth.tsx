import { motion } from 'framer-motion';
import { ArrowLeft, MailCheck } from 'lucide-react';
import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { passwordStrength, validatePassword } from '@nba/shared';
import { Mascot } from '../components/Mascot';
import { ApiError, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Field, Notice, PasswordInput, Spinner, useDocumentTitle, useInterval, useToast } from '../lib/ui';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function AuthShell({ title, subtitle, children, back }: { title: string; subtitle?: string; children: ReactNode; back?: { to: string; label: string } }) {
  return (
    <div className="wrap page auth-page">
      <motion.div className="card auth-card" initial={{ opacity: 0, y: 22 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
        {back && (
          <Link to={back.to} className="small row" style={{ gap: 6, marginBottom: 10 }}>
            <ArrowLeft size={15} /> {back.label}
          </Link>
        )}
        <div className="row" style={{ gap: 14, flexWrap: 'nowrap', alignItems: 'center' }}>
          <Mascot size={58} />
          <div>
            <h1 style={{ fontSize: 'clamp(1.6rem,4vw,2.1rem)' }}>{title}</h1>
            {subtitle && <p className="muted" style={{ margin: 0 }}>{subtitle}</p>}
          </div>
        </div>
        <div className="stack" style={{ marginTop: 22 }}>{children}</div>
      </motion.div>
    </div>
  );
}

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
}

/** Zod-style details from the API: [{path, message}] -> field map. */
function fieldErrors(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (e instanceof ApiError && Array.isArray(e.details)) for (const d of e.details) if (d?.path && !out[d.path]) out[d.path] = d.message;
  return out;
}

/* ================================================================== signup */
export function Signup() {
  useDocumentTitle('Create account');
  const nav = useNavigate();
  const [f, setF] = useState({ fullName: '', email: '', phone: '', password: '', confirmPassword: '', termsAccepted: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const strength = passwordStrength(f.password);
  const set = (k: keyof typeof f) => (v: string | boolean) => {
    setF((s) => ({ ...s, [k]: v }));
    setErrors((e) => { const { [k]: _drop, ...rest } = e; return k === 'password' ? (({ confirmPassword: _c, ...r }) => r)(rest) : rest; });
  };

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (f.fullName.trim().length < 2) e.fullName = 'Please enter your full name.';
    if (!EMAIL_RE.test(f.email.trim())) e.email = 'Please enter a valid email address.';
    if (f.phone && !/^\+?[0-9][0-9 ()\-]{6,19}$/.test(f.phone.trim())) e.phone = 'Please enter a valid phone number.';
    const p = validatePassword(f.password, { email: f.email, name: f.fullName });
    if (p) e.password = p;
    if (f.password !== f.confirmPassword) e.confirmPassword = 'Passwords do not match.';
    if (!f.termsAccepted) e.termsAccepted = 'You must accept the Terms and Privacy Policy to continue.';
    return e;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await post<{ resendAfterSec: number }>('/api/auth/signup', { ...f, email: f.email.trim(), phone: f.phone.trim() || undefined }, false);
      nav('/verify-email', { state: { email: f.email.trim().toLowerCase(), resendAfterSec: r.resendAfterSec } });
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errMsg(err));
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Create your account" subtitle="Free to start. We email a 6-digit code to confirm it’s you.">
      <form onSubmit={submit} noValidate className="stack">
        {error && <Notice kind="error">{error}</Notice>}
        <Field label="Full name" htmlFor="fullName" error={errors.fullName}>
          <input id="fullName" className="input" autoComplete="name" value={f.fullName} onChange={(e) => set('fullName')(e.target.value)} aria-invalid={!!errors.fullName || undefined} aria-describedby={errors.fullName ? 'fullName-err' : undefined} />
        </Field>
        <Field label="Email" htmlFor="email" error={errors.email}>
          <input id="email" className="input" type="email" autoComplete="email" value={f.email} onChange={(e) => set('email')(e.target.value)} aria-invalid={!!errors.email || undefined} aria-describedby={errors.email ? 'email-err' : undefined} />
        </Field>
        <Field label="Phone (optional)" htmlFor="phone" error={errors.phone}>
          <input id="phone" className="input" type="tel" autoComplete="tel" value={f.phone} onChange={(e) => set('phone')(e.target.value)} aria-invalid={!!errors.phone || undefined} aria-describedby={errors.phone ? 'phone-err' : undefined} />
        </Field>
        <Field label="Password" htmlFor="password" error={errors.password} hint="At least 8 characters with a letter and a number.">
          <PasswordInput id="password" value={f.password} onChange={set('password')} autoComplete="new-password" invalid={!!errors.password} />
          {f.password && (
            <div style={{ marginTop: 8 }} aria-live="polite">
              <div className="strength" data-score={strength.score}><i /><i /><i /><i /></div>
              <span className="small muted">Strength: {strength.label}</span>
            </div>
          )}
        </Field>
        <Field label="Confirm password" htmlFor="confirmPassword" error={errors.confirmPassword}>
          <PasswordInput id="confirmPassword" value={f.confirmPassword} onChange={set('confirmPassword')} autoComplete="new-password" invalid={!!errors.confirmPassword} />
        </Field>
        <div>
          <label className="check small">
            <input type="checkbox" checked={f.termsAccepted} onChange={(e) => set('termsAccepted')(e.target.checked)} />
            <span>I agree to the <Link to="/terms" target="_blank">Terms</Link> and <Link to="/privacy" target="_blank">Privacy Policy</Link>.</span>
          </label>
          {errors.termsAccepted && <span className="field-error" role="alert">{errors.termsAccepted}</span>}
        </div>
        <button className="btn btn-yellow" disabled={busy}>{busy ? <Spinner label="Creating account" /> : 'Create account'}</button>
        <p className="small muted" style={{ textAlign: 'center' }}>Already registered? <Link to="/login">Log in</Link></p>
      </form>
    </AuthShell>
  );
}

/* ================================================================== OTP verification */
export function VerifyEmail() {
  useDocumentTitle('Verify your email');
  const loc = useLocation();
  const nav = useNavigate();
  const toast = useToast();
  const state = (loc.state ?? {}) as { email?: string; resendAfterSec?: number };
  const email = state.email;
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(state.resendAfterSec ?? 60);
  const [resending, setResending] = useState(false);
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useInterval(() => setCooldown((c) => Math.max(0, c - 1)), cooldown > 0 ? 1000 : null);
  useEffect(() => refs.current[0]?.focus(), []);

  if (!email) {
    return (
      <AuthShell title="Verify your email">
        <Notice>Start by creating an account, then enter the code we email you.</Notice>
        <Link className="btn btn-yellow" to="/signup">Create account</Link>
      </AuthShell>
    );
  }

  const code = digits.join('');
  function setAt(i: number, v: string) {
    const d = v.replace(/\D/g, '');
    setDigits((cur) => {
      const next = [...cur];
      if (d.length <= 1) next[i] = d;
      else d.slice(0, 6 - i).split('').forEach((ch, k) => (next[i + k] = ch));
      return next;
    });
    if (d) refs.current[Math.min(5, i + Math.max(1, d.length))]?.focus();
  }
  function onKey(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowRight' && i < 5) refs.current[i + 1]?.focus();
  }
  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const t = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!t) return;
    e.preventDefault();
    setDigits(Array.from({ length: 6 }, (_, k) => t[k] ?? ''));
    refs.current[Math.min(5, t.length)]?.focus();
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (code.length !== 6) return setError('Enter the 6-digit code from your email.');
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/verify-otp', { email, code, purpose: 'signup' }, false);
      toast('Email verified. You can log in now.');
      nav('/login', { replace: true, state: { email, verified: true } });
    } catch (err) {
      setError(errMsg(err));
      setDigits(Array(6).fill(''));
      refs.current[0]?.focus();
      setBusy(false);
    }
  }

  async function resend() {
    setResending(true);
    setError(null);
    try {
      const r = await post<{ resendAfterSec: number }>('/api/auth/resend-otp', { email, purpose: 'signup' }, false);
      setCooldown(r.resendAfterSec ?? 60);
      toast('If the address can be used, a new code is on its way.');
    } catch (err) {
      if (err instanceof ApiError && err.retryAfterSec) setCooldown(err.retryAfterSec);
      setError(errMsg(err));
    } finally {
      setResending(false);
    }
  }

  return (
    <AuthShell title="Check your email" subtitle={`We sent a 6-digit code to ${email}.`} back={{ to: '/signup', label: 'Use a different email' }}>
      <form onSubmit={submit} className="stack" noValidate>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="otp" role="group" aria-label="6-digit verification code">
          {digits.map((d, i) => (
            <input key={i} ref={(el) => { refs.current[i] = el; }} inputMode="numeric" autoComplete={i === 0 ? 'one-time-code' : 'off'} maxLength={6} value={d} aria-label={`Digit ${i + 1}`} onChange={(e) => setAt(i, e.target.value)} onKeyDown={(e) => onKey(i, e)} onPaste={onPaste} />
          ))}
        </div>
        <button className="btn btn-yellow" disabled={busy || code.length !== 6}>{busy ? <Spinner label="Verifying" /> : <><MailCheck size={18} /> Verify email</>}</button>
        <p className="small muted" style={{ textAlign: 'center' }}>
          Didn’t get it?{' '}
          {cooldown > 0 ? <span aria-live="polite">You can resend in {cooldown}s</span> : <button type="button" className="linklike" onClick={resend} disabled={resending}>Resend code</button>}
        </p>
        <p className="small muted" style={{ textAlign: 'center' }}>The code expires in 10 minutes and works once. Check your spam folder too.</p>
      </form>
    </AuthShell>
  );
}

/* ================================================================== login */
export function Login() {
  useDocumentTitle('Log in');
  const { login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const st = (loc.state ?? {}) as { email?: string; next?: string; verified?: boolean; reset?: boolean };
  const [email, setEmail] = useState(st.email ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [hint, setHint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unverified, setUnverified] = useState(false);

  useInterval(() => setWait((w) => Math.max(0, w - 1)), wait > 0 ? 1000 : null);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    setUnverified(false);
    if (!EMAIL_RE.test(email.trim())) return setError('Please enter a valid email address.');
    if (!password) return setError('Please enter your password.');
    setBusy(true);
    try {
      await login(email.trim(), password);
      nav(st.next && st.next.startsWith('/') ? st.next : '/dashboard', { replace: true });
    } catch (err) {
      setError(errMsg(err));
      if (err instanceof ApiError) {
        if (err.retryAfterSec) setWait(err.retryAfterSec);
        if (err.details?.captchaRequired) setHint(true);
        if (err.code === 'email_not_verified') setUnverified(true);
      }
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Welcome back" subtitle="Log in to see your tests and reports.">
      <form onSubmit={submit} noValidate className="stack">
        {st.verified && <Notice kind="ok">Email verified. Please log in.</Notice>}
        {st.reset && <Notice kind="ok">Password changed. Please log in with your new password.</Notice>}
        {error && <Notice kind="error">{error}{wait > 0 ? ` Try again in ${wait}s.` : ''}</Notice>}
        {hint && <Notice>Several attempts failed. Further attempts are slowed down automatically to protect your account. You can also <Link to="/forgot-password">reset your password</Link>.</Notice>}
        {unverified && <Link className="btn btn-ghost" to="/verify-email" state={{ email: email.trim().toLowerCase(), resendAfterSec: 0 }}>Enter verification code</Link>}
        <Field label="Email" htmlFor="login-email">
          <input id="login-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="login-password">
          <PasswordInput id="login-password" value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
        <div className="row spread"><Link className="small" to="/forgot-password">Forgot password?</Link></div>
        <button className="btn btn-yellow" disabled={busy || wait > 0}>{busy ? <Spinner label="Signing in" /> : wait > 0 ? `Wait ${wait}s` : 'Log in'}</button>
        <p className="small muted" style={{ textAlign: 'center' }}>New here? <Link to="/signup">Create an account</Link></p>
      </form>
    </AuthShell>
  );
}

/* ================================================================== forgot / reset */
export function ForgotPassword() {
  useDocumentTitle('Forgot password');
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    if (!EMAIL_RE.test(email.trim())) return setError('Please enter a valid email address.');
    setBusy(true);
    try {
      await post('/api/auth/forgot-password', { email: email.trim() }, false);
      nav('/reset-password', { state: { email: email.trim().toLowerCase() } });
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }
  return (
    <AuthShell title="Reset your password" subtitle="We’ll email you a 6-digit code." back={{ to: '/login', label: 'Back to log in' }}>
      <form onSubmit={submit} noValidate className="stack">
        {error && <Notice kind="error">{error}</Notice>}
        <Field label="Email" htmlFor="fp-email"><input id="fp-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <button className="btn btn-yellow" disabled={busy}>{busy ? <Spinner label="Sending" /> : 'Send code'}</button>
      </form>
    </AuthShell>
  );
}

export function ResetPassword() {
  useDocumentTitle('Choose a new password');
  const loc = useLocation();
  const nav = useNavigate();
  const [email, setEmail] = useState(((loc.state ?? {}) as { email?: string }).email ?? '');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const strength = passwordStrength(pw);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setError(null);
    const e: Record<string, string> = {};
    if (!EMAIL_RE.test(email.trim())) e.email = 'Please enter a valid email address.';
    if (!/^\d{6}$/.test(code.trim())) e.code = 'Enter the 6-digit code from your email.';
    const p = validatePassword(pw, { email });
    if (p) e.newPassword = p;
    if (pw !== pw2) e.confirmPassword = 'Passwords do not match.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await post('/api/auth/reset-password', { email: email.trim(), code: code.trim(), newPassword: pw, confirmPassword: pw2 }, false);
      nav('/login', { replace: true, state: { email: email.trim(), reset: true } });
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errMsg(err));
      setBusy(false);
    }
  }
  return (
    <AuthShell title="Choose a new password" subtitle="Enter the code we emailed you." back={{ to: '/forgot-password', label: 'Send a new code' }}>
      <form onSubmit={submit} noValidate className="stack">
        {error && <Notice kind="error">{error}</Notice>}
        <Field label="Email" htmlFor="rp-email" error={errors.email}><input id="rp-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="6-digit code" htmlFor="rp-code" error={errors.code}><input id="rp-code" className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="New password" htmlFor="rp-pw" error={errors.newPassword}>
          <PasswordInput id="rp-pw" value={pw} onChange={setPw} autoComplete="new-password" invalid={!!errors.newPassword} />
          {pw && <div style={{ marginTop: 8 }}><div className="strength" data-score={strength.score}><i /><i /><i /><i /></div><span className="small muted">Strength: {strength.label}</span></div>}
        </Field>
        <Field label="Confirm new password" htmlFor="rp-pw2" error={errors.confirmPassword}><PasswordInput id="rp-pw2" value={pw2} onChange={setPw2} autoComplete="new-password" invalid={!!errors.confirmPassword} /></Field>
        <button className="btn btn-yellow" disabled={busy}>{busy ? <Spinner label="Saving" /> : 'Change password'}</button>
      </form>
    </AuthShell>
  );
}
