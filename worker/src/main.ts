import http from 'node:http';
import { Queue, Worker } from 'bullmq';
import { createAiProvider } from '@nba/shared/ai';
import { Redis } from 'ioredis';
import { QUEUE_JOB_OPTIONS, QUEUE_NAME, type TestJobPayload } from '@nba/shared';
import { loadConfig } from './config.js';
import { createPool } from './lib/db.js';
import { createLogger } from './lib/logger.js';
import { Store } from './lib/store.js';
import { Orchestrator } from './orchestrator.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const pool = createPool(config.databaseUrl);
  const store = new Store(pool);
  const orchestrator = new Orchestrator({ store, config, logger, ai: createAiProvider() });

  // BullMQ requires maxRetriesPerRequest = null on its blocking connection.
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue<TestJobPayload>(QUEUE_NAME, { connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }) });

  const worker = new Worker<TestJobPayload>(
    QUEUE_NAME,
    async (job) => {
      const outcome = await orchestrator.runJob(job.data.jobId);
      return { outcome };
    },
    {
      connection,
      concurrency: config.WORKER_CONCURRENCY,
      lockDuration: config.LOCK_DURATION_MS,
      stalledInterval: config.STALLED_INTERVAL_MS,
      maxStalledCount: 5,
    },
  );
  worker.on('failed', (job, err) => logger.error({ queueJob: job?.id, err: String(err) }, 'queue job attempt failed'));
  worker.on('error', (err) => logger.error({ err: String(err) }, 'worker error'));

  // Reaper: the database is the source of truth, so a job whose queue message was lost (Redis flush, crash
  // between insert and enqueue) or whose worker died is re-enqueued here. Enqueueing is idempotent because
  // the BullMQ job id is the test job id.
  const reap = async (): Promise<void> => {
    try {
      const stale = await store.findRecoverableJobs(config.STALE_AFTER_MS, config.STALE_AFTER_MS);
      for (const j of stale) {
        const existing = await queue.getJob(j.id);
        const state = existing ? await existing.getState() : null;
        if (state === 'active' || state === 'waiting' || state === 'delayed') continue;
        if (existing) await existing.remove().catch(() => undefined);
        await queue.add('run', { jobId: j.id }, { ...QUEUE_JOB_OPTIONS, jobId: j.id });
        logger.warn({ jobId: j.id, status: j.status }, 're-enqueued orphaned job');
      }
    } catch (err) {
      logger.error({ err: String(err) }, 'reaper failed');
    }
  };
  const reaperTimer = setInterval(reap, config.REAPER_INTERVAL_MS);
  reaperTimer.unref();
  void reap();

  let ready = true;
  const health = config.PORT
    ? http
        .createServer((req, res) => {
          if (req.url === '/healthz') {
            res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: ready, workerId: config.workerId }));
          } else res.writeHead(404).end();
        })
        .listen(config.PORT)
    : null;

  logger.info({ workerId: config.workerId, concurrency: config.WORKER_CONCURRENCY }, 'worker started');

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    ready = false;
    logger.info({ signal }, 'shutting down; in-flight tests stay resumable');
    clearInterval(reaperTimer);
    orchestrator.requestShutdown();
    await worker.close().catch(() => undefined);
    await queue.close().catch(() => undefined);
    await connection.quit().catch(() => undefined);
    health?.close();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err: String(err) }, 'unhandled rejection'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal worker error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
