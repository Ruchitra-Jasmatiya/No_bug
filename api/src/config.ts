import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SUPABASE_DB_URL: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  /** Supabase project URL: used to fetch the JWKS (asymmetric signing keys). */
  SUPABASE_URL: z.string().url().optional(),
  /** Legacy HS256 JWT secret. Server-side only. */
  SUPABASE_JWT_SECRET: z.string().min(16).optional(),
  /** Comma separated list of allowed browser origins. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  /** Secret used to key OTP hashes. 32+ random characters. Server-side only. */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  AUTH_PROVIDER: z.enum(['supabase', 'local']).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(3).optional(),
  /** Receives security alerts. Never hardcoded; unset means events are recorded but no email is sent. */
  ADMIN_NOTIFICATION_EMAIL: z.string().email().optional(),
});

export interface ApiConfig extends z.infer<typeof schema> {
  databaseUrl: string;
  corsOrigins: string[];
  authProvider: 'supabase' | 'local';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  // A blank `KEY=` line in .env means "not set", not an invalid empty value.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid API configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const databaseUrl = parsed.data.SUPABASE_DB_URL ?? parsed.data.DATABASE_URL;
  if (!databaseUrl) throw new Error('Invalid API configuration: set SUPABASE_DB_URL (or DATABASE_URL)');
  if (!parsed.data.SUPABASE_JWT_SECRET && !parsed.data.SUPABASE_URL) {
    throw new Error('Invalid API configuration: set SUPABASE_URL (JWKS) or SUPABASE_JWT_SECRET to verify user tokens');
  }
  const d = parsed.data;
  const authProvider = d.AUTH_PROVIDER ?? (d.SUPABASE_URL && d.SUPABASE_SERVICE_ROLE_KEY && d.SUPABASE_ANON_KEY ? 'supabase' : 'local');
  if (authProvider === 'supabase' && !(d.SUPABASE_URL && d.SUPABASE_SERVICE_ROLE_KEY && d.SUPABASE_ANON_KEY)) {
    throw new Error('Invalid API configuration: the supabase auth provider needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY');
  }
  if (authProvider === 'local' && !d.SUPABASE_JWT_SECRET) {
    throw new Error('Invalid API configuration: the local auth provider needs SUPABASE_JWT_SECRET (used to sign dev tokens)');
  }
  if (d.NODE_ENV === 'production') {
    if (authProvider !== 'supabase') throw new Error('Invalid API configuration: the local auth provider is for development and tests only; use Supabase Auth in production');
    if (!d.RESEND_API_KEY || !d.EMAIL_FROM) throw new Error('Invalid API configuration: RESEND_API_KEY and EMAIL_FROM are required in production (email OTP cannot work without them)');
  }
  return {
    ...parsed.data,
    authProvider,
    databaseUrl,
    corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
}
