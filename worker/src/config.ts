import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SUPABASE_DB_URL: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  WORKER_ID: z.string().min(1).optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  /** How often a running job proves it is alive. */
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(100).default(5_000),
  /** A running job with no heartbeat for this long is considered orphaned and may be taken over. */
  STALE_AFTER_MS: z.coerce.number().int().min(500).default(30_000),
  REAPER_INTERVAL_MS: z.coerce.number().int().min(500).default(15_000),
  /** BullMQ lock: if a worker dies, its job is handed to another worker after this long. */
  LOCK_DURATION_MS: z.coerce.number().int().min(1_000).default(30_000),
  STALLED_INTERVAL_MS: z.coerce.number().int().min(500).default(10_000),
  CHROME_EXECUTABLE_PATH: z.string().optional(),
  CHROMIUM_NO_SANDBOX: z.enum(['true', 'false']).optional(),
  /** Optional port for a /healthz endpoint (some platforms require one). */
  PORT: z.coerce.number().int().optional(),
});

export type WorkerConfig = z.infer<typeof schema> & { workerId: string; databaseUrl: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== '')); // blank KEY= means unset
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid worker configuration: ${detail}`);
  }
  const databaseUrl = parsed.data.SUPABASE_DB_URL ?? parsed.data.DATABASE_URL;
  if (!databaseUrl) throw new Error('Invalid worker configuration: set SUPABASE_DB_URL (or DATABASE_URL)');
  return { ...parsed.data, databaseUrl, workerId: parsed.data.WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}` };
}
