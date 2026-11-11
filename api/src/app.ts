import cors from 'cors';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import type pg from 'pg';
import type { NetPolicy, Resolver } from '@nba/shared/net';
import type { ApiConfig } from './config.js';
import type { Logger } from './lib/logger.js';
import { EmailService } from './email/service.js';
import { type EmailTransport, ResendTransport, UnconfiguredTransport } from './email/transports.js';
import { type IdentityProvider } from './auth/identity.js';
import { LocalIdentity } from './auth/local-identity.js';
import { OtpService } from './auth/otp.js';
import { AuthService } from './auth/service.js';
import { SupabaseIdentity } from './auth/supabase-identity.js';
import { Throttle } from './auth/throttle.js';
import { createAuthRouter } from './routes/auth.js';
import { createAuthenticator } from './middleware/auth.js';
import { createErrorHandler, notFoundHandler } from './middleware/error.js';
import type { JobQueue } from './queue/queue.js';
import { createAdminRouter } from './routes/admin.js';
import { createBugsRouter } from './routes/bugs.js';
import { createChatRouter } from './routes/chat.js';
import { createPublicRouter } from './routes/public.js';
import { createTestsRouter } from './routes/tests.js';
import { AdminService } from './services/admin.js';
import { ChatService } from './services/chat.js';
import { JobService } from './services/jobs.js';
import { SecurityMonitor } from './services/security-monitor.js';
import type { AiProvider } from '@nba/shared/ai';

export interface AppDeps {
  config: ApiConfig;
  pool: pg.Pool;
  queue: JobQueue;
  logger: Logger;
  policy: NetPolicy;
  resolver?: Resolver;
  /** Injected by tests. Production builds both from the configuration. */
  identity?: IdentityProvider;
  emailTransport?: EmailTransport;
  /** Null / undefined = AI not configured (BUGSY chat reports that honestly). */
  ai?: AiProvider | null;
}

export function buildIdentity(config: ApiConfig, pool: pg.Pool): IdentityProvider {
  if (config.authProvider === 'supabase') {
    return new SupabaseIdentity(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!, config.SUPABASE_ANON_KEY!, pool);
  }
  return new LocalIdentity(pool, {
    jwtSecret: config.SUPABASE_JWT_SECRET!,
    issuer: config.SUPABASE_URL ? new URL('/auth/v1', config.SUPABASE_URL).toString().replace(/\/$/, '') : undefined,
  });
}

export function createApp(deps: AppDeps): { app: Express; jobs: JobService; authService: AuthService } {
  const { config, pool, queue, logger } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // Non-browser clients send no Origin. Browsers must come from an allowed origin.
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        cb(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type', 'x-requested-with'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(
    rateLimit({
      windowMs: 15 * 60_000,
      limit: config.NODE_ENV === 'test' ? 10_000 : 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: (req) => req.path === '/healthz',
      message: { error: { code: 'rate_limited', message: 'Too many requests. Please slow down and try again shortly.' } },
    }),
  );

  const auth = createAuthenticator(config, pool);
  const jobs = new JobService({ pool, queue, policy: deps.policy, logger, resolver: deps.resolver });

  const identity = deps.identity ?? buildIdentity(config, pool);
  if (identity.name === 'local' && config.NODE_ENV === 'production') {
    throw new Error('The local identity provider must not be used in production.');
  }
  const transport = deps.emailTransport ?? (config.RESEND_API_KEY && config.EMAIL_FROM ? new ResendTransport(config.RESEND_API_KEY, config.EMAIL_FROM) : new UnconfiguredTransport());
  const emailService = new EmailService(pool, transport, logger);
  const monitor = new SecurityMonitor(pool, emailService, config.ADMIN_NOTIFICATION_EMAIL, logger);
  const authService = new AuthService({
    pool,
    identity,
    otp: new OtpService(pool, config.SESSION_SECRET),
    email: emailService,
    throttle: new Throttle(pool),
    logger,
    monitor,
  });
  const ai = deps.ai ?? null;
  const chat = new ChatService(pool, ai, logger);
  const admin = new AdminService(pool, queue, identity, {
    aiConfigured: ai !== null,
    emailConfigured: !(transport instanceof UnconfiguredTransport),
    adminEmailConfigured: Boolean(config.ADMIN_NOTIFICATION_EMAIL),
    authProvider: identity.name,
  });

  app.use(createPublicRouter({ pool, queue }));
  app.use(
    '/api/auth',
    rateLimit({
      windowMs: 15 * 60_000,
      limit: config.NODE_ENV === 'test' ? 10_000 : 200,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'rate_limited', message: 'Too many requests. Please slow down and try again shortly.' } },
    }),
    createAuthRouter({ auth: authService, pool, authn: auth, production: config.NODE_ENV === 'production' }),
  );
  app.use('/api/tests', createTestsRouter({ pool, jobs, auth }));
  app.use('/api/bugs', createBugsRouter({ pool, auth }));
  app.use('/api/chat', createChatRouter({ chat, auth }));
  app.use('/api/admin', createAdminRouter({ admin, auth }));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return { app, jobs, authService };
}
