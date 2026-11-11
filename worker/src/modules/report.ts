import type { ModuleResult, TestModule } from './types.js';

/**
 * Final aggregation step. The job summary itself is computed from the stored results by the store when
 * the job finishes; this module records an honest "what ran / what did not" note for the report.
 */
export const reportModule: TestModule = {
  id: 'report_generation',
  async run(ctx): Promise<ModuleResult> {
    const ran: string[] = [];
    const gaps: string[] = [];
    for (const id of ctx.job.selected_modules) {
      if (id === 'report_generation') continue;
      const prior = ctx.prior(id);
      if (!prior) continue;
      if (prior.status === 'completed') ran.push(id);
      else gaps.push(`${id}:${prior.status}`);
    }
    return {
      status: 'completed',
      outcomes: [],
      note: gaps.length ? `Some modules did not complete: ${gaps.join(', ')}.` : undefined,
      checkpoint: { modulesCompleted: ran, modulesNotCompleted: gaps },
    };
  },
};
