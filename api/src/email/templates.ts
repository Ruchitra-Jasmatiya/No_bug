const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const wrap = (title: string, bodyHtml: string) => `<!doctype html><html><body style="margin:0;background:#F5F0E4;font-family:Georgia,'Times New Roman',serif;color:#30372E">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFCF4;border:1px solid #DDDCCF;border-radius:16px">
<tr><td style="padding:28px 32px 8px;font-size:13px;letter-spacing:.12em;color:#687B58;font-weight:bold">NO BUGS ALLOWED</td></tr>
<tr><td style="padding:0 32px 8px;font-size:22px">${esc(title)}</td></tr>
<tr><td style="padding:8px 32px 32px;font-size:15px;line-height:1.6">${bodyHtml}</td></tr>
</table></td></tr></table></body></html>`;

const codeBlock = (code: string) => `<p style="font-size:34px;letter-spacing:.35em;font-weight:bold;background:#F6EDC8;border-radius:12px;padding:14px 0;text-align:center;margin:20px 0">${esc(code)}</p>`;

export function otpEmail(opts: { name: string; code: string; purpose: 'signup' | 'password_reset'; ttlMinutes: number }) {
  const signup = opts.purpose === 'signup';
  const subject = signup ? 'Your NO BUGS ALLOWED verification code' : 'Your NO BUGS ALLOWED password reset code';
  const intro = signup ? 'Use this code to verify your email address and activate your account:' : 'Use this code to reset your password:';
  const outro = `The code expires in ${opts.ttlMinutes} minutes and can be used once. If you did not request it, you can ignore this email; nobody can access your account without the code.`;
  return {
    subject,
    text: `Hi ${opts.name},\n\n${intro}\n\n${opts.code}\n\n${outro}\n\n— NO BUGS ALLOWED`,
    html: wrap(subject, `<p>Hi ${esc(opts.name)},</p><p>${esc(intro)}</p>${codeBlock(opts.code)}<p style="color:#77796D;font-size:13px">${esc(outro)}</p>`),
  };
}

export function accountExistsEmail(opts: { name: string }) {
  const subject = 'You already have a NO BUGS ALLOWED account';
  const body = 'Someone (hopefully you) tried to create an account with this email address, but one already exists. You can sign in, or use "Forgot password" if you do not remember your password. If this was not you, no action is needed.';
  return { subject, text: `Hi ${opts.name},\n\n${body}\n\n— NO BUGS ALLOWED`, html: wrap(subject, `<p>Hi ${esc(opts.name)},</p><p>${esc(body)}</p>`) };
}

export function passwordChangedEmail(opts: { name: string }) {
  const subject = 'Your NO BUGS ALLOWED password was changed';
  const body = 'Your password was just changed and all other sessions were signed out. If this was not you, reset your password immediately and contact support.';
  return { subject, text: `Hi ${opts.name},\n\n${body}\n\n— NO BUGS ALLOWED`, html: wrap(subject, `<p>Hi ${esc(opts.name)},</p><p>${esc(body)}</p>`) };
}

const KIND_LABEL: Record<string, string> = {
  failed_logins_account: 'Repeated failed sign-ins on one account',
  failed_logins_ip: 'Repeated failed sign-ins from one network address',
  password_spraying: 'Possible password-spraying (one address, many accounts)',
};

export function securityAlertEmail(o: { kind: string; risk: string; email: string | null; ip: string | null; userAgent: string | null; count: number; windowMinutes: number; at: Date }) {
  const label = KIND_LABEL[o.kind] ?? o.kind;
  const subject = `[Security] ${label} — NO BUGS ALLOWED`;
  const rows: Array<[string, string]> = [
    ['Event', label],
    ['Risk level', o.risk],
    ['Failed attempts', `${o.count} within ${o.windowMinutes} minutes`],
    ['Account email', o.email ?? '— (multiple or unknown)'],
    ['IP address', o.ip ?? 'unknown'],
    ['Browser / device', (o.userAgent ?? 'unknown').slice(0, 160)],
    ['Time (UTC)', o.at.toISOString()],
    ['Action taken', 'Sign-ins are being delayed automatically; no account was locked permanently.'],
  ];
  const text = `${label}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nReview it in the admin dashboard → Security.`;
  const table = rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#77796D">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join('');
  return { subject, text, html: wrap(subject, `<table role="presentation" style="font-size:14px">${table}</table><p style="color:#77796D;font-size:13px">Review and acknowledge it in the admin dashboard → Security.</p>`) };
}
