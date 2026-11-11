import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    // Never let credentials reach structured logs.
    redact: { paths: ['*.password', '*.token', '*.authorization', '*.apiKey', 'headers.authorization', 'headers.cookie'], censor: '[redacted]' },
    base: { service: 'nba-worker' },
  });
}
