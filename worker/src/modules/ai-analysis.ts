import { AiError, buildAnalysisPrompt, parseAnalysisResponse, type FindingForAi } from '@nba/shared/ai';
import type { ModuleResult, TestModule } from './types.js';

const BATCH = 5;

/**
 * Adds AI explanations to bugs the tests really found. AI output goes to bug_reports.ai_analysis only:
 * evidence, severity, confidence and status are never touched. Without a configured provider the module is
 * "skipped" and the report says so; an absent AI is not counted as an incomplete test run.
 */
export const aiAnalysisModule: TestModule = {
  id: 'ai_analysis',
  async run(ctx): Promise<ModuleResult> {
    if (!ctx.ai) {
      const n = await ctx.store.skipRemainingPendingBugs(ctx.job.id);
      return { status: 'skipped', note: 'AI analysis is not configured on this server (no AI API key). Test findings and recommended fixes are unaffected.', outcomes: [], checkpoint: { skippedBugs: n } };
    }
    let analysed = 0;
    let failed = 0;
    let providerDown: string | null = null;

    // Loop on 'pending' rows so a resumed attempt only processes what is left.
    const cap = ctx.settings.ai.maxFindings;
    let budget = cap;
    while (budget > 0 && !ctx.signal.aborted && !providerDown) {
      const rows = await ctx.store.pendingBugsForAi(ctx.job.id, Math.min(BATCH, budget));
      if (rows.length === 0) break;
      budget -= rows.length;
      const findings: FindingForAi[] = rows.map((r) => ({
        id: r.id,
        code: r.issue_code,
        category: r.category,
        severity: r.severity,
        confidence: r.confidence,
        title: r.title,
        description: r.description,
        affectedUrl: r.affected_url || null,
        evidence: r.evidence,
        suggestedFix: r.suggested_fix,
      }));
      const { system, user } = buildAnalysisPrompt(findings);
      try {
        const res = await ctx.ai.complete({ system, messages: [{ role: 'user', content: user }], maxTokens: 3000, temperature: 0.2, signal: ctx.signal });
        const { valid } = parseAnalysisResponse(res.text, findings.map((f) => f.id));
        for (const r of rows) {
          const a = valid.get(r.id);
          if (a) {
            await ctx.store.setBugAi(r.id, 'completed', { ...a, id: undefined, model: res.model, generatedAt: new Date().toISOString() });
            analysed++;
          } else {
            await ctx.store.setBugAi(r.id, 'failed', null);
            failed++;
          }
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        const e = err instanceof AiError ? err : null;
        providerDown = e ? `${e.code}` : 'error';
        for (const r of rows) await ctx.store.setBugAi(r.id, 'failed', null);
        failed += rows.length;
        await ctx.log('warn', `AI provider error (${providerDown}); remaining findings keep their standard recommendations.`);
      }
    }
    const skipped = await ctx.store.skipRemainingPendingBugs(ctx.job.id);
    if (analysed === 0 && failed > 0) {
      return { status: 'blocked', note: `AI analysis could not be completed (${providerDown ?? 'invalid responses'}). Findings are unaffected.`, outcomes: [], checkpoint: { analysed, failed, skipped } };
    }
    return {
      status: 'completed',
      note: `${analysed} finding(s) explained${failed ? `, ${failed} could not be analysed` : ''}${skipped ? `, ${skipped} not analysed (limit)` : ''}.`,
      outcomes: [],
      checkpoint: { analysed, failed, skipped },
    };
  },
};
