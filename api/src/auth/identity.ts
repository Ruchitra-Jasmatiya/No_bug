export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime in seconds. */
  expiresIn: number;
  userId: string;
}

export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
}

export type SignInResult = { kind: 'ok'; session: Session } | { kind: 'bad_credentials' } | { kind: 'unverified' };

export class EmailExistsError extends Error {
  constructor() {
    super('email already registered');
    this.name = 'EmailExistsError';
  }
}

/**
 * The credential store and session issuer. Production uses Supabase Auth; the local implementation exists so
 * the whole flow can be developed and tested without a Supabase project. Everything above this interface
 * (OTP, throttling, suspension, audit, emails) is identical for both.
 */
export interface IdentityProvider {
  readonly name: 'supabase' | 'local';
  /** Creates an UNVERIFIED account that cannot sign in until markEmailVerified is called. */
  createUser(input: { email: string; password: string; fullName: string; phone?: string }): Promise<{ id: string }>;
  updatePendingUser(id: string, input: { password: string; fullName: string; phone?: string }): Promise<void>;
  markEmailVerified(id: string): Promise<void>;
  signIn(email: string, password: string, ctx: ClientContext): Promise<SignInResult>;
  /** Rotates the refresh token. Returns null for an unknown, expired, revoked or reused token. */
  refresh(refreshToken: string, ctx: ClientContext): Promise<Session | null>;
  /** Ends the session that owns this refresh token. */
  revoke(refreshToken: string): Promise<void>;
  revokeAllSessions(userId: string): Promise<void>;
  setPassword(userId: string, newPassword: string): Promise<void>;
}
