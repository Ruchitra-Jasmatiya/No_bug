import type { Logger } from '../lib/logger.js';

/** Delivers one-time codes over WhatsApp. The code is never logged by real providers. */
export interface WhatsAppSender {
  readonly name: 'meta' | 'twilio' | 'console' | 'none';
  /** `to` is an E.164 number such as +919876543210. Throws WhatsAppSendError on failure. */
  sendOtp(to: string, code: string, ttlMinutes: number): Promise<{ providerId: string | null }>;
}

export class WhatsAppSendError extends Error {
  constructor(message = 'whatsapp delivery failed') {
    super(message);
    this.name = 'WhatsAppSendError';
  }
}

type Fetch = typeof fetch;

/** WhatsApp Business Cloud API (Meta). Needs an approved authentication template whose body takes one {{1}} variable (the code). */
export class MetaCloudSender implements WhatsAppSender {
  readonly name = 'meta' as const;
  constructor(
    private readonly o: { phoneNumberId: string; accessToken: string; template: string; language: string },
    private readonly f: Fetch = fetch,
  ) {}
  async sendOtp(to: string, code: string): Promise<{ providerId: string | null }> {
    const res = await this.f(`https://graph.facebook.com/v20.0/${encodeURIComponent(this.o.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.o.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: this.o.template,
          language: { code: this.o.language },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            // Authentication templates with a copy-code button need the code repeated for the button.
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[]; error?: { message?: string } };
    if (!res.ok) throw new WhatsAppSendError(`meta: ${body.error?.message ?? res.status}`);
    return { providerId: body.messages?.[0]?.id ?? null };
  }
}

/** Twilio WhatsApp. Uses a plain message body (works in the Twilio sandbox; production needs an approved template/sender). */
export class TwilioSender implements WhatsAppSender {
  readonly name = 'twilio' as const;
  constructor(
    private readonly o: { accountSid: string; authToken: string; from: string },
    private readonly f: Fetch = fetch,
  ) {}
  async sendOtp(to: string, code: string, ttlMinutes: number): Promise<{ providerId: string | null }> {
    const form = new URLSearchParams({
      To: `whatsapp:${to}`,
      From: this.o.from.startsWith('whatsapp:') ? this.o.from : `whatsapp:${this.o.from}`,
      Body: `${code} is your NO BUGS ALLOWED verification code. It expires in ${ttlMinutes} minutes. Never share it with anyone.`,
    });
    const res = await this.f(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.o.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${this.o.accountSid}:${this.o.authToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) throw new WhatsAppSendError(`twilio: ${body.message ?? res.status}`);
    return { providerId: body.sid ?? null };
  }
}

/** Development only: prints the code in the API terminal so sign-up can be tried without a WhatsApp account. */
export class ConsoleSender implements WhatsAppSender {
  readonly name = 'console' as const;
  constructor(private readonly logger: Logger) {}
  async sendOtp(to: string, code: string, ttlMinutes: number): Promise<{ providerId: string | null }> {
    // eslint-disable-next-line no-console
    console.log(`\n[DEV ONLY] WhatsApp code for ${to}: ${code}  (valid ${ttlMinutes} min)\n`);
    this.logger.warn({ provider: 'console' }, 'development WhatsApp sender in use: codes are printed to this terminal, not sent');
    return { providerId: null };
  }
}

export class NoSender implements WhatsAppSender {
  readonly name = 'none' as const;
  async sendOtp(): Promise<{ providerId: string | null }> {
    throw new WhatsAppSendError('no WhatsApp provider configured');
  }
}

export interface WhatsAppEnv {
  WHATSAPP_PROVIDER?: 'meta' | 'twilio' | 'console';
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_OTP_TEMPLATE?: string;
  WHATSAPP_TEMPLATE_LANGUAGE?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_WHATSAPP_FROM?: string;
  NODE_ENV: string;
}

export function buildWhatsAppSender(env: WhatsAppEnv, logger: Logger): WhatsAppSender {
  if (env.WHATSAPP_PROVIDER === 'meta' && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN) {
    return new MetaCloudSender({ phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, accessToken: env.WHATSAPP_ACCESS_TOKEN, template: env.WHATSAPP_OTP_TEMPLATE ?? 'nba_otp', language: env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'en' });
  }
  if (env.WHATSAPP_PROVIDER === 'twilio' && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM) {
    return new TwilioSender({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_WHATSAPP_FROM });
  }
  // The console sender is only ever built outside production.
  if (env.WHATSAPP_PROVIDER === 'console' && env.NODE_ENV !== 'production') return new ConsoleSender(logger);
  return new NoSender();
}
