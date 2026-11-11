/**
 * Provider-independent AI layer. Nothing here fakes a response: when no key is configured
 * `createAiProvider` returns null and callers must say so honestly.
 */

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  system: string;
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface AiResponse {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export type AiErrorCode = 'auth' | 'rate_limited' | 'unavailable' | 'timeout' | 'bad_response' | 'aborted' | 'rejected';

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete(req: AiRequest): Promise<AiResponse>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchLike;
  /** Test hook: replaces the backoff sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT = 60_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function statusToError(status: number): AiError {
  if (status === 401 || status === 403) return new AiError('auth', 'The AI provider rejected the configured API key.', false, status);
  if (status === 429) return new AiError('rate_limited', 'The AI provider is rate limiting requests.', true, status);
  if (status === 408 || status >= 500) return new AiError('unavailable', 'The AI provider is temporarily unavailable.', true, status);
  return new AiError('rejected', `The AI provider rejected the request (HTTP ${status}).`, false, status);
}

abstract class BaseProvider implements AiProvider {
  abstract readonly name: string;
  readonly model: string;
  protected readonly apiKey: string;
  protected readonly timeoutMs: number;
  protected readonly maxRetries: number;
  protected readonly fetchImpl: FetchLike;
  protected readonly sleep: (ms: number) => Promise<void>;
  protected readonly baseUrl: string;

  constructor(opts: ProviderOptions, defaultBase: string) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? defaultBase).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.sleep = opts.sleep ?? defaultSleep;
  }

  protected abstract buildRequest(req: AiRequest): { url: string; headers: Record<string, string>; body: unknown };
  protected abstract parse(json: unknown): AiResponse;

  async complete(req: AiRequest): Promise<AiResponse> {
    let lastErr: AiError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (req.signal?.aborted) throw new AiError('aborted', 'The AI request was cancelled.');
      try {
        return await this.once(req);
      } catch (err) {
        const e = err instanceof AiError ? err : new AiError('unavailable', 'The AI provider could not be reached.', true);
        lastErr = e;
        if (!e.retryable || attempt === this.maxRetries) throw e;
        await this.sleep(Math.min(500 * 2 ** attempt, 4000) + Math.floor(Math.random() * 150));
      }
    }
    throw lastErr ?? new AiError('unavailable', 'The AI provider could not be reached.');
  }

  private async once(req: AiRequest): Promise<AiResponse> {
    const { url, headers, body } = this.buildRequest(req);
    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), this.timeoutMs);
    const timeout = timeoutCtl.signal;
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    } catch (err) {
      clearTimeout(timer);
      if (req.signal?.aborted) throw new AiError('aborted', 'The AI request was cancelled.');
      if (timeout.aborted) throw new AiError('timeout', 'The AI provider took too long to respond.', true);
      void err;
      throw new AiError('unavailable', 'The AI provider could not be reached.', true);
    }
    if (!res.ok) {
      // Provider error bodies can echo prompts; only the status is kept.
      await res.arrayBuffer().catch(() => undefined);
      clearTimeout(timer);
      throw statusToError(res.status);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AiError('bad_response', 'The AI provider returned an unreadable response.');
    } finally {
      clearTimeout(timer);
    }
    return this.parse(json);
  }
}

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic';
  constructor(opts: ProviderOptions) {
    super(opts, 'https://api.anthropic.com');
  }
  protected buildRequest(req: AiRequest) {
    return {
      url: `${this.baseUrl}/v1/messages`,
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: {
        model: this.model,
        max_tokens: req.maxTokens ?? 2048,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        system: req.system,
        messages: req.messages,
      },
    };
  }
  protected parse(json: unknown): AiResponse {
    const j = json as { content?: Array<{ type?: string; text?: string }>; model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = (j.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    if (!text) throw new AiError('bad_response', 'The AI provider returned an empty response.');
    return { text, model: j.model ?? this.model, usage: { inputTokens: j.usage?.input_tokens, outputTokens: j.usage?.output_tokens } };
  }
}

/** Any provider exposing the OpenAI chat-completions shape (OpenAI, OpenRouter, Together, local servers ...). */
export class OpenAiCompatibleProvider extends BaseProvider {
  readonly name = 'openai-compatible';
  constructor(opts: ProviderOptions) {
    super(opts, 'https://api.openai.com/v1');
  }
  protected buildRequest(req: AiRequest) {
    return {
      url: `${this.baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        max_tokens: req.maxTokens ?? 2048,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        messages: [{ role: 'system', content: req.system }, ...req.messages],
      },
    };
  }
  protected parse(json: unknown): AiResponse {
    const j = json as { choices?: Array<{ message?: { content?: string } }>; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = j.choices?.[0]?.message?.content;
    if (!text) throw new AiError('bad_response', 'The AI provider returned an empty response.');
    return { text, model: j.model ?? this.model, usage: { inputTokens: j.usage?.prompt_tokens, outputTokens: j.usage?.completion_tokens } };
  }
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

/**
 * Builds the configured provider, or returns null when no API key is set.
 * AI_PROVIDER: anthropic (default) | openai | openai-compatible. AI_API_KEY (or ANTHROPIC_API_KEY for anthropic).
 */
export function createAiProvider(env: Record<string, string | undefined> = process.env, fetchImpl?: FetchLike): AiProvider | null {
  const kind = (env.AI_PROVIDER ?? 'anthropic').trim().toLowerCase();
  const timeoutMs = env.AI_TIMEOUT_MS ? Math.max(1000, Number(env.AI_TIMEOUT_MS) || DEFAULT_TIMEOUT) : DEFAULT_TIMEOUT;
  if (kind === 'anthropic') {
    const apiKey = env.AI_API_KEY || env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    return new AnthropicProvider({ apiKey, model: env.AI_MODEL || DEFAULT_ANTHROPIC_MODEL, baseUrl: env.AI_BASE_URL, timeoutMs, fetchImpl });
  }
  if (kind === 'openai' || kind === 'openai-compatible') {
    const apiKey = env.AI_API_KEY;
    if (!apiKey || !env.AI_MODEL) return null;
    return new OpenAiCompatibleProvider({ apiKey, model: env.AI_MODEL, baseUrl: env.AI_BASE_URL, timeoutMs, fetchImpl });
  }
  throw new Error(`Unsupported AI_PROVIDER "${kind}". Use anthropic, openai or openai-compatible.`);
}
