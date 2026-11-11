import type pg from 'pg';
import type { Logger } from '../lib/logger.js';
import type { EmailTransport, OutgoingEmail } from './transports.js';

export class EmailSendError extends Error {
  constructor(message = 'email delivery failed') {
    super(message);
    this.name = 'EmailSendError';
  }
}

/**
 * Sends through the transport and keeps an audit row in email_notifications.
 * The audit row stores recipient, template and status only: never the body, so one-time codes are never persisted
 * in plain text and never logged.
 */
export class EmailService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly transport: EmailTransport,
    private readonly logger: Logger,
  ) {}

  async send(template: string, message: OutgoingEmail, userId?: string | null): Promise<void> {
    const row = await this.pool.query<{ id: string }>(
      `insert into public.email_notifications (user_id, to_email, template, subject) values ($1,$2,$3,$4) returning id`,
      [userId ?? null, message.to, template, message.subject],
    );
    const id = row.rows[0]!.id;
    try {
      const { providerId } = await this.transport.send(message);
      await this.pool.query(`update public.email_notifications set status = 'sent', sent_at = now(), provider_message_id = $2 where id = $1`, [id, providerId]);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      this.logger.error({ template, reason }, 'email delivery failed');
      await this.pool.query(`update public.email_notifications set status = 'failed', error = $2 where id = $1`, [id, reason.slice(0, 300)]);
      throw new EmailSendError();
    }
  }
}
