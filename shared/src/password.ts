/** Password rules shared by the API (authoritative) and the web UI (instant feedback). */

const COMMON = new Set(
  ['password', 'password1', 'password123', 'passw0rd', 'qwerty123', 'qwertyuiop', '12345678', '123456789', '1234567890', 'iloveyou', 'admin123',
    'welcome1', 'welcome123', 'letmein123', 'abc12345', 'monkey123', 'dragon123', 'football1', 'baseball1', 'sunshine1', 'princess1', 'trustno1',
    'changeme', 'changeme123', 'nobugsallowed', 'nobugsallowed1', '11111111', '00000000', 'qazwsx123', '1q2w3e4r', 'zaq12wsx', 'p@ssw0rd', 'p@ssword1'].map((s) => s.toLowerCase()),
);

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export interface PasswordContext {
  email?: string;
  name?: string;
}

/** Returns a user-facing problem, or null when the password is acceptable. */
export function validatePassword(password: string, ctx: PasswordContext = {}): string | null {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  if (!/[A-Za-z]/.test(password)) return 'Password must include at least one letter.';
  if (!/\d/.test(password)) return 'Password must include at least one number.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common. Please choose a different one.';
  if (/^(.)\1+$/.test(password)) return 'Password cannot be a single repeated character.';
  const local = ctx.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return 'Password must not contain your email address.';
  const first = ctx.name?.trim().split(/\s+/)[0]?.toLowerCase();
  if (first && first.length >= 4 && lower.includes(first)) return 'Password must not contain your name.';
  return null;
}

export type StrengthLabel = 'Too weak' | 'Weak' | 'Fair' | 'Good' | 'Strong';

/** Heuristic strength for the UI indicator (0-4). Not a security control: validatePassword is. */
export function passwordStrength(password: string): { score: 0 | 1 | 2 | 3 | 4; label: StrengthLabel } {
  if (!password) return { score: 0, label: 'Too weak' };
  let points = 0;
  if (password.length >= 8) points++;
  if (password.length >= 12) points++;
  if (password.length >= 16) points++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) points++;
  if (/\d/.test(password)) points++;
  if (/[^A-Za-z0-9]/.test(password)) points++;
  if (COMMON.has(password.toLowerCase()) || /^(.)\1+$/.test(password)) points = Math.min(points, 1);
  const score = (points <= 1 ? 0 : points <= 2 ? 1 : points <= 3 ? 2 : points <= 4 ? 3 : 4) as 0 | 1 | 2 | 3 | 4;
  return { score, label: (['Too weak', 'Weak', 'Fair', 'Good', 'Strong'] as const)[score] };
}
