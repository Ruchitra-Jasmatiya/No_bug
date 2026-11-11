export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailTransport {
  send(message: OutgoingEmail): Promise<{ providerId: string | null }>;
}

/** Production transport: Resend's HTTPS API. */
export class ResendTransport implements EmailTransport {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(m: OutgoingEmail): Promise<{ providerId: string | null }> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Provider error bodies can echo request data; keep only the status in the thrown message.
      throw new Error(`email provider responded with HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { providerId: body.id ?? null };
  }
}

/** Test transport: keeps messages in memory so tests can read the code the user would receive. */
export class MemoryTransport implements EmailTransport {
  readonly sent: OutgoingEmail[] = [];
  failNext = false;
  async send(m: OutgoingEmail): Promise<{ providerId: string | null }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated provider failure');
    }
    this.sent.push(m);
    return { providerId: `mem-${this.sent.length}` };
  }
  lastTo(email: string): OutgoingEmail | undefined {
    return [...this.sent].reverse().find((m) => m.to === email);
  }
  codeFor(email: string): string {
    const m = this.lastTo(email);
    const code = m && /\b(\d{6})\b/.exec(m.text)?.[1];
    if (!code) throw new Error(`no code email for ${email}`);
    return code;
  }
}

/** Used when no provider is configured: refuses loudly instead of silently dropping emails. */
export class UnconfiguredTransport implements EmailTransport {
  async send(): Promise<{ providerId: string | null }> {
    throw new Error('No email provider is configured (set RESEND_API_KEY and EMAIL_FROM).');
  }
}
