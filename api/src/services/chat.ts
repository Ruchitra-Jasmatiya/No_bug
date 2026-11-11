import type pg from 'pg';
import { AiError, CHAT_SYSTEM_PROMPT, buildChatContext, type AiProvider, type ChatContext } from '@nba/shared/ai';
import { HttpError, notFound, tooMany } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

const SEV_ORDER = `array_position(array['critical','high','medium','low','informational'], severity)`;
const MAX_ISSUES_IN_CONTEXT = 25;
const HISTORY_MESSAGES = 12;
const MESSAGES_PER_HOUR = 40;

/* eslint-disable @typescript-eslint/no-explicit-any */
export class ChatService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly ai: AiProvider | null,
    private readonly logger: Logger,
  ) {}

  status(): { configured: boolean; provider: string | null } {
    return { configured: this.ai !== null, provider: this.ai?.name ?? null };
  }

  async listConversations(userId: string, jobId?: string) {
    const { rows } = await this.pool.query(
      `select c.id, c.title, c.job_id, c.created_at, c.updated_at,
              (select count(*)::int from public.chatbot_messages m where m.conversation_id = c.id) as message_count
         from public.chatbot_conversations c
        where c.user_id = $1 and ($2::uuid is null or c.job_id = $2)
        order by c.updated_at desc limit 50`,
      [userId, jobId ?? null],
    );
    return rows.map((r) => ({ id: r.id, title: r.title, jobId: r.job_id, messageCount: r.message_count, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  async createConversation(userId: string, jobId: string | null) {
    if (jobId) await this.ownedJob(userId, jobId);
    const { rows } = await this.pool.query(`insert into public.chatbot_conversations (user_id, job_id) values ($1,$2) returning id, title, job_id, created_at, updated_at`, [userId, jobId]);
    const r = rows[0];
    return { id: r.id, title: r.title, jobId: r.job_id, messageCount: 0, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  async getConversation(userId: string, id: string) {
    const conv = await this.ownedConversation(userId, id);
    const { rows } = await this.pool.query(`select id, role, content, metadata, created_at from public.chatbot_messages where conversation_id = $1 order by created_at, id limit 500`, [id]);
    return {
      conversation: { id: conv.id, title: conv.title, jobId: conv.job_id, createdAt: conv.created_at, updatedAt: conv.updated_at },
      messages: rows.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.created_at, grounded: Boolean(m.metadata?.grounded) })),
    };
  }

  async deleteConversation(userId: string, id: string): Promise<void> {
    await this.ownedConversation(userId, id);
    await this.pool.query('delete from public.chatbot_conversations where id = $1', [id]);
  }

  async send(userId: string, conversationId: string, content: string) {
    const conv = await this.ownedConversation(userId, conversationId);
    if (!this.ai) {
      throw new HttpError(503, 'ai_not_configured', 'BUGSY’s AI is not configured on this server yet, so chat is unavailable. Your test results and the recommended fixes are still available in the report.');
    }
    const recent = await this.pool.query<{ n: number }>(
      `select count(*)::int as n from public.chatbot_messages m join public.chatbot_conversations c on c.id = m.conversation_id
        where c.user_id = $1 and m.role = 'user' and m.created_at > now() - interval '1 hour'`,
      [userId],
    );
    if ((recent.rows[0]?.n ?? 0) >= MESSAGES_PER_HOUR) throw tooMany('You have reached the hourly message limit for BUGSY. Please try again a little later.');

    const history = await this.pool.query<{ role: 'user' | 'assistant'; content: string }>(
      `select role, content from (select role, content, created_at, id from public.chatbot_messages where conversation_id = $1 order by created_at desc, id desc limit $2) t order by created_at, id`,
      [conversationId, HISTORY_MESSAGES],
    );
    const context = conv.job_id ? await this.buildContext(userId, conv.job_id) : null;
    const system = context
      ? `${CHAT_SYSTEM_PROMPT}\n\n${buildChatContext(context)}`
      : `${CHAT_SYSTEM_PROMPT}\n\nNo test report is attached to this conversation. Answer general website-quality questions, and say clearly that you have no test data for this conversation.`;

    const messages = [...history.rows, { role: 'user' as const, content }];
    // The Anthropic API requires the first message to be from the user and roles to alternate.
    while (messages.length > 1 && messages[0]!.role !== 'user') messages.shift();

    let reply: string;
    try {
      reply = (await this.ai.complete({ system, messages, maxTokens: 1200, temperature: 0.3 })).text.trim();
    } catch (err) {
      const code = err instanceof AiError ? err.code : 'unavailable';
      this.logger.warn({ code }, 'chat completion failed');
      throw new HttpError(code === 'rate_limited' ? 429 : 503, 'ai_unavailable', 'BUGSY could not answer just now. Please try again in a moment. Your message was not lost.');
    }
    if (!reply) throw new HttpError(503, 'ai_unavailable', 'BUGSY returned an empty answer. Please try again.');

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const u = await client.query(`insert into public.chatbot_messages (conversation_id, role, content, created_at) values ($1,'user',$2, clock_timestamp()) returning id, created_at`, [conversationId, content]);
      const a = await client.query(`insert into public.chatbot_messages (conversation_id, role, content, metadata, created_at) values ($1,'assistant',$2,$3::jsonb, clock_timestamp()) returning id, created_at`, [
        conversationId,
        reply,
        JSON.stringify({ grounded: context !== null, model: this.ai.model }),
      ]);
      const title = conv.title === 'New conversation' ? content.replace(/\s+/g, ' ').slice(0, 60) : conv.title;
      await client.query('update public.chatbot_conversations set title = $2, updated_at = now() where id = $1', [conversationId, title]);
      await client.query('commit');
      return {
        user: { id: u.rows[0].id, role: 'user' as const, content, createdAt: u.rows[0].created_at, grounded: false },
        assistant: { id: a.rows[0].id, role: 'assistant' as const, content: reply, createdAt: a.rows[0].created_at, grounded: context !== null },
        title,
      };
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Quick prompts generated from REAL results of a report (no AI call, nothing invented). */
  async suggestions(userId: string, jobId: string): Promise<string[]> {
    const job = await this.ownedJob(userId, jobId);
    const bugs = await this.pool.query(`select issue_code, title, severity from public.bug_reports where job_id = $1 order by ${SEV_ORDER}, created_at limit 3`, [jobId]);
    const out: string[] = [];
    if (job.status !== 'completed') return ['What is being tested right now?', 'How long will this take?'];
    const top = bugs.rows[0];
    if (top) out.push(`Explain ${top.issue_code}: “${String(top.title).slice(0, 60)}”`);
    if (bugs.rows.length > 0) out.push('What should I fix first?');
    out.push(bugs.rows.length === 0 ? 'What was and was not tested?' : 'Summarise this report in plain language');
    const prev = await this.previousJob(userId, job);
    if (prev) out.push('What changed since my last test?');
    return out.slice(0, 4);
  }

  // ------------------------------------------------------------------ context
  private async ownedJob(userId: string, jobId: string): Promise<any> {
    const { rows } = await this.pool.query('select * from public.test_jobs where id = $1 and user_id = $2', [jobId, userId]);
    if (!rows[0]) throw notFound('Test not found.');
    return rows[0];
  }

  private async ownedConversation(userId: string, id: string): Promise<any> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Conversation not found.');
    const { rows } = await this.pool.query('select * from public.chatbot_conversations where id = $1 and user_id = $2', [id, userId]);
    if (!rows[0]) throw notFound('Conversation not found.');
    return rows[0];
  }

  private async previousJob(userId: string, job: any): Promise<any | null> {
    const { rows } = await this.pool.query(
      `select * from public.test_jobs where user_id = $1 and hostname = $2 and status = 'completed' and id <> $3 and coalesce(finished_at, created_at) < coalesce($4::timestamptz, now()) order by finished_at desc nulls last limit 1`,
      [userId, job.hostname, job.id, job.finished_at],
    );
    return rows[0] ?? null;
  }

  async buildContext(userId: string, jobId: string): Promise<ChatContext> {
    const job = await this.ownedJob(userId, jobId);
    const [mods, bugs, total, logs, counts] = await Promise.all([
      this.pool.query('select module_id, status, note from public.test_modules where job_id = $1 order by position', [jobId]),
      this.pool.query(`select * from public.bug_reports where job_id = $1 order by ${SEV_ORDER}, created_at limit ${MAX_ISSUES_IN_CONTEXT}`, [jobId]),
      this.pool.query<{ n: number }>('select count(*)::int as n from public.bug_reports where job_id = $1', [jobId]),
      this.pool.query(`select message from public.test_logs where job_id = $1 and level in ('warn','error') order by id desc limit 12`, [jobId]),
      this.pool.query<{ status: string; n: number }>('select status, count(*)::int as n from public.test_results where job_id = $1 group by status', [jobId]),
    ]);
    const prev = await this.previousJob(userId, job);
    let previous: ChatContext['previous'] = null;
    if (prev) {
      const [pb, cb] = await Promise.all([
        this.pool.query('select title, affected_url from public.bug_reports where job_id = $1', [prev.id]),
        this.pool.query('select title, affected_url from public.bug_reports where job_id = $1', [jobId]),
      ]);
      const key = (r: any) => `${r.title}|${r.affected_url}`;
      const before = new Map<string, any>(pb.rows.map((r) => [key(r), r]));
      const now = new Map<string, any>(cb.rows.map((r) => [key(r), r]));
      previous = {
        finishedAt: prev.finished_at ? new Date(prev.finished_at).toISOString() : null,
        bugs: pb.rows.length,
        fixed: [...before.entries()].filter(([k]) => !now.has(k)).map(([, r]) => r.title),
        newIssues: [...now.entries()].filter(([k]) => !before.has(k)).map(([, r]) => r.title),
        remaining: [...now.keys()].filter((k) => before.has(k)).length,
      };
    }
    return {
      hostname: job.hostname,
      targetUrl: job.target_url,
      status: job.status,
      overall: job.summary?.overall ?? null,
      incomplete: Boolean(job.summary?.incomplete),
      finishedAt: job.finished_at ? new Date(job.finished_at).toISOString() : null,
      counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
      modules: mods.rows.map((m) => ({ id: m.module_id, label: m.module_id, status: m.status, note: m.note })),
      issues: bugs.rows.map((b) => ({ code: b.issue_code, severity: b.severity, confidence: b.confidence, category: b.category, title: b.title, description: b.description, affectedUrl: b.affected_url || null, suggestedFix: b.suggested_fix, evidence: b.evidence, ai: b.ai_analysis })),
      issuesOmitted: Math.max(0, (total.rows[0]?.n ?? 0) - bugs.rows.length),
      recentLogs: logs.rows.map((l) => l.message).reverse(),
      previous,
    };
  }
}
