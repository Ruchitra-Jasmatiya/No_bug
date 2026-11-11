import { MODULE_BY_ID, MAX_MODULE_ATTEMPTS, SETTLED_MODULE_STATUSES, type ModuleId } from '@nba/shared';
import { getNetPolicy, type NetPolicy } from '@nba/shared/net';
import type { AiProvider } from '@nba/shared/ai';
import { BrowserSession } from './browser/session.js';
import type { WorkerConfig } from './config.js';
import type { Logger } from './lib/logger.js';
import { type JobRow, type ModuleRow, Store } from './lib/store.js';
import { getModule } from './modules/registry.js';
import type { ModuleContext, ModuleResult, PriorModule } from './modules/types.js';

export type RunOutcome =
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'skipped_terminal' // job already finished: redelivered message, nothing to do
  | 'skipped_held' // another live worker owns it
  | 'interrupted'; // shutting down: left resumable

export interface OrchestratorDeps {
  store: Store;
  config: WorkerConfig;
  logger: Logger;
  policy?: NetPolicy;
  ai?: AiProvider | null;
}

class StopSignal extends Error {
  constructor(readonly reason: 'cancelled' | 'lost_ownership' | 'shutdown' | 'deadline') {
    super(reason);
  }
}

const SETTLED = new Set<string>(SETTLED_MODULE_STATUSES);

export class Orchestrator {
  private readonly shutdown = new AbortController();

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Ask in-flight jobs to stop at the next safe point. They stay resumable. */
  requestShutdown(): void {
    this.shutdown.abort();
  }

  async runJob(jobId: string): Promise<RunOutcome> {
    const { store, config, logger } = this.deps;
    const policy = this.deps.policy ?? getNetPolicy();
    const log = logger.child({ jobId, workerId: config.workerId });

    const claim = await store.claimJob(jobId, config.workerId, config.STALE_AFTER_MS);
    switch (claim.kind) {
      case 'missing':
        log.warn('job not found; dropping message');
        return 'skipped_terminal';
      case 'terminal':
        log.info({ status: claim.status }, 'job already finished; nothing to do');
        return 'skipped_terminal';
      case 'held':
        log.info({ lockedBy: claim.lockedBy }, 'job is owned by a live worker; not taking over');
        return 'skipped_held';
      case 'exhausted':
        log.error('job exhausted its attempts');
        await store.failExhausted(jobId);
        return 'failed';
    }
    const job = claim.job;
    log.info({ attempt: job.attempt }, 'job claimed');

    const jobAbort = new AbortController();
    let stop: StopSignal | null = null;
    const requestStop = (reason: StopSignal['reason']) => {
      if (!stop) {
        stop = new StopSignal(reason);
        jobAbort.abort(stop);
      }
    };
    this.shutdown.signal.addEventListener('abort', () => requestStop('shutdown'), { once: true });

    // Heartbeat: proves liveness, detects lost ownership and picks up cancel requests.
    const hb = setInterval(() => {
      store
        .heartbeat(job.id, config.workerId)
        .then((r) => {
          if (!r.owned) requestStop('lost_ownership');
          else if (r.cancelRequested) requestStop('cancelled');
        })
        .catch((err) => log.warn({ err: String(err) }, 'heartbeat failed'));
    }, config.HEARTBEAT_INTERVAL_MS);
    hb.unref();

    const settings = await store.loadSettings();
    const deadline = setTimeout(() => requestStop('deadline'), settings.timeouts.jobMs);
    deadline.unref();

    const browser = new BrowserSession({
      policy,
      executablePath: config.CHROME_EXECUTABLE_PATH,
      noSandbox: config.CHROMIUM_NO_SANDBOX ? config.CHROMIUM_NO_SANDBOX === 'true' : undefined,
    });

    try {
      await store.ensureModules(job);
      await store.appendLog(job.id, null, 'info', job.attempt > 1 ? `Resuming test (attempt ${job.attempt}) from the last saved checkpoint.` : 'Test started.');

      let fatal: string | null = null;
      const priors = new Map<ModuleId, PriorModule>();
      let modules = await store.getModules(job.id);
      for (const m of modules) if (SETTLED.has(m.status)) priors.set(m.module_id, { status: m.status, checkpoint: m.checkpoint });

      // A previous attempt may already have decided the target is unusable.
      fatal = this.recoverFatal(modules);

      for (const row of modules) {
        if (stop) break;
        if (SETTLED.has(row.status)) continue; // checkpoint: never rerun settled modules

        const def = MODULE_BY_ID[row.module_id];
        const impl = getModule(row.module_id);

        if (fatal) {
          await this.settle(job, row, { status: 'blocked', note: fatal, outcomes: [] }, browser, 0);
          priors.set(row.module_id, { status: 'blocked', checkpoint: {} });
          continue;
        }
        if (!impl) {
          await this.settle(job, row, { status: 'skipped', note: 'Not available in this version of the platform.', outcomes: [] }, browser, 0);
          await store.appendLog(job.id, row.module_id, 'info', `${def.label}: skipped (not available in this version).`);
          priors.set(row.module_id, { status: 'skipped', checkpoint: {} });
          continue;
        }
        if (row.attempt >= MAX_MODULE_ATTEMPTS) {
          // Poison-module guard: it already crashed the worker repeatedly.
          const msg = `${def.label} did not finish after ${row.attempt} attempts and was marked failed.`;
          await this.settle(job, row, { status: 'failed', error: msg, note: msg, outcomes: [] }, browser, 0);
          priors.set(row.module_id, { status: 'failed', checkpoint: {} });
          continue;
        }

        const attempt = await store.startModule(job.id, row.module_id);
        await store.appendLog(job.id, row.module_id, 'info', `${def.label}: started${attempt > 1 ? ` (attempt ${attempt})` : ''}.`);
        const started = Date.now();

        const moduleAbort = new AbortController();
        const onJobAbort = () => moduleAbort.abort(jobAbort.signal.reason);
        jobAbort.signal.addEventListener('abort', onJobAbort, { once: true });
        const moduleTimer = setTimeout(() => moduleAbort.abort(new Error('module timeout')), settings.timeouts.moduleMs);
        moduleTimer.unref();

        const ctx: ModuleContext = {
          job,
          store,
          target: { url: job.target_url, hostname: job.hostname },
          settings,
          policy,
          config,
          ai: this.deps.ai ?? null,
          signal: moduleAbort.signal,
          log: (level, message, meta) => store.appendLog(job.id, row.module_id, level, message, meta),
          prior: (id) => priors.get(id),
          browser: async () => {
            await browser.start();
            return browser;
          },
        };

        let result: ModuleResult;
        try {
          result = await withAbort(impl.run(ctx), moduleAbort.signal);
        } catch (err) {
          if (stop) {
            // Interrupted by cancel / shutdown / lost ownership: give the module back, do not settle it.
            await store.releaseModule(job.id, row.module_id).catch(() => undefined);
            break;
          }
          const timedOut = (err as Error)?.message === 'module timeout';
          const msg = timedOut ? `${def.label} timed out.` : `${def.label} could not be completed.`;
          log.error({ err: String(err), module: row.module_id }, 'module crashed');
          result = { status: timedOut ? 'blocked' : 'failed', note: msg, error: msg, outcomes: [] };
          await store.appendLog(job.id, row.module_id, 'error', msg, { detail: String((err as Error)?.message ?? err).slice(0, 300) });
        } finally {
          clearTimeout(moduleTimer);
          jobAbort.signal.removeEventListener('abort', onJobAbort);
        }

        await this.settle(job, row, result, browser, Date.now() - started);
        priors.set(row.module_id, { status: result.status, checkpoint: result.checkpoint ?? {} });
        await store.appendLog(job.id, row.module_id, result.status === 'completed' ? 'info' : 'warn', `${def.label}: ${result.status}${result.note ? ` — ${result.note}` : ''}.`);
        if (result.fatal) {
          fatal = result.fatal;
          await store.appendLog(job.id, row.module_id, 'warn', `Remaining modules will not run: ${result.fatal}`);
        }
      }

      const s = stop as StopSignal | null;
      if (s) {
        if (s.reason === 'cancelled') {
          await store.appendLog(job.id, null, 'info', 'Test cancelled.');
          await store.finishJob(job.id, config.workerId, 'cancelled');
          return 'cancelled';
        }
        if (s.reason === 'deadline') {
          await store.appendLog(job.id, null, 'error', 'The test exceeded its maximum run time.');
          await store.finishJob(job.id, config.workerId, 'failed', 'The test exceeded its maximum run time.');
          return 'failed';
        }
        // shutdown or lost ownership: leave the job resumable for another worker.
        if (s.reason === 'shutdown') {
          await store.releaseJob(job.id, config.workerId);
          await store.appendLog(job.id, null, 'info', 'Worker is restarting; the test will resume from its last checkpoint.');
        }
        return 'interrupted';
      }

      await store.finishJob(job.id, config.workerId, 'completed');
      await store.appendLog(job.id, null, 'info', 'Test finished. Your testing report is ready.');
      return 'completed';
    } catch (err) {
      log.error({ err: String(err) }, 'job failed unexpectedly');
      // Let the queue retry: state is checkpointed, so a retry resumes where this attempt stopped.
      throw err;
    } finally {
      clearInterval(hb);
      clearTimeout(deadline);
      await browser.close();
    }
  }

  private recoverFatal(modules: ModuleRow[]): string | null {
    for (const m of modules) {
      if (m.status === 'blocked' && m.note && !/^Not available/.test(m.note)) return m.note;
    }
    const conn = modules.find((m) => m.module_id === 'connectivity');
    const cp = conn?.checkpoint as { reachable?: boolean } | undefined;
    if (conn?.status === 'completed' && cp?.reachable === false) return 'The website could not be reached.';
    return null;
  }

  private async settle(job: JobRow, row: ModuleRow, result: ModuleResult, browser: BrowserSession, durationMs: number): Promise<void> {
    const env = {
      browser: browser.isStarted ? `Chromium ${browser.version}` : null,
      worker: this.deps.config.workerId,
      testedAt: new Date().toISOString(),
    };
    await this.deps.store.settleModule(job, row.module_id, result, env, durationMs);
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
