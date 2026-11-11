import type { CheckOutcome, ModuleId, ModuleStatus } from '@nba/shared';
import type { NetPolicy } from '@nba/shared/net';
import type { AiProvider } from '@nba/shared/ai';
import type { BrowserSession } from '../browser/session.js';
import type { WorkerConfig } from '../config.js';
import type { AppSettings, JobRow, Store } from '../lib/store.js';

export interface ModuleResult {
  /**
   * completed - the module ran; its outcomes (pass / fail / warning ...) are the findings
   * blocked   - the module could not run (tool unavailable, prerequisite missing, timed out)
   * skipped   - intentionally not run
   * failed    - the module crashed; never counted as a pass
   */
  status: Extract<ModuleStatus, 'completed' | 'failed' | 'skipped' | 'blocked'>;
  note?: string;
  error?: string;
  outcomes: CheckOutcome[];
  /** Small, durable data for later modules and for recovery. Stored in test_modules.checkpoint. */
  checkpoint?: Record<string, unknown>;
  /** If set, the target is unusable: remaining modules are marked blocked with this note. */
  fatal?: string;
}

export interface PriorModule {
  status: ModuleStatus;
  checkpoint: Record<string, unknown>;
}

export interface ModuleContext {
  job: JobRow;
  store: Store;
  target: { url: string; hostname: string };
  settings: AppSettings;
  policy: NetPolicy;
  config: WorkerConfig;
  /** Null when no AI key is configured. */
  ai: AiProvider | null;
  /** Aborts on cancellation, module timeout, job deadline or shutdown. */
  signal: AbortSignal;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): Promise<void>;
  /** Checkpoint of an earlier module in this job (survives worker restarts). */
  prior(moduleId: ModuleId): PriorModule | undefined;
  /** Lazily starts the per-job browser. Throws BrowserUnavailableError if it cannot run. */
  browser(): Promise<BrowserSession>;
}

export interface TestModule {
  id: ModuleId;
  run(ctx: ModuleContext): Promise<ModuleResult>;
}
