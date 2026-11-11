import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service: 'nba-api' },
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.otp', '*.apiKey'], censor: '[redacted]' },
  });
}
