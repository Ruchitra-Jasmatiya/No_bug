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
  /** Wrong passwords allowed per account inside one window before it is locked for the whole window. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(2).max(20).default(5),
  LOGIN_WINDOW_SEC: z.coerce.number().int().min(10).max(3600).default(60),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  /** Secret used to key OTP hashes. 32+ random characters. Server-side only. */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  AUTH_PROVIDER: z.enum(['supabase', 'local']).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(3).optional(),
  /** One-time codes are delivered on WhatsApp. 'console' prints the code in the API terminal (development only). */
  WHATSAPP_PROVIDER: z.enum(['meta', 'twilio', 'console']).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
  WHATSAPP_OTP_TEMPLATE: z.string().min(1).optional(),
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().min(2).optional(),
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_WHATSAPP_FROM: z.string().min(5).optional(),
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
    if (d.WHATSAPP_PROVIDER === 'console') throw new Error('Invalid API configuration: WHATSAPP_PROVIDER=console is for development only');
    if (!d.WHATSAPP_PROVIDER && (!d.RESEND_API_KEY || !d.EMAIL_FROM)) throw new Error('Invalid API configuration: set WHATSAPP_PROVIDER (meta or twilio) with its credentials, or RESEND_API_KEY and EMAIL_FROM, in production (one-time codes cannot be delivered otherwise)');
  }
  return {
    ...parsed.data,
    authProvider,
    databaseUrl,
    corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
}
