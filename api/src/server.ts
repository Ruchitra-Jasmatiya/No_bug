import { createAiProvider } from '@nba/shared/ai';
import { getNetPolicy } from '@nba/shared/net';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './lib/db.js';
import { createLogger } from './lib/logger.js';
import { createJobQueue } from './queue/queue.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const pool = createPool(config.databaseUrl);
const queue = createJobQueue(config.REDIS_URL);
const policy = getNetPolicy(); // throws if private targets are enabled in production

const { app } = createApp({ config, pool, queue, logger, policy, ai: createAiProvider() });
const server = app.listen(config.PORT, () => logger.info({ port: config.PORT, env: config.NODE_ENV }, 'api listening'));

async function stop(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  server.close();
  await queue.close();
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
