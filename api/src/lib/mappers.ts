import {
  EMPTY_COUNTS,
  MODULE_BY_ID,
  type BugDTO,
  type JobDTO,
  type JobSummary,
  type LogDTO,
  type ModuleId,
  type ModuleStateDTO,
  type ResultCounts,
  type ResultDTO,
} from '@nba/shared';

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toJobDTO(r: any): JobDTO {
  return {
    id: r.id,
    targetUrl: r.target_url,
    hostname: r.hostname,
    status: r.status,
    progressPct: r.progress_pct,
    currentModule: r.current_module,
    lastCompletedModule: r.last_completed_module,
    selectedModules: r.selected_modules,
    attempt: r.attempt,
    errorMessage: r.error_message,
    cancelRequested: r.cancel_requested,
    queuedAt: iso(r.queued_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    heartbeatAt: iso(r.heartbeat_at),
    updatedAt: iso(r.updated_at)!,
    summary: (r.summary as JobSummary | null) ?? null,
  };
}

export function toModuleDTO(r: any): ModuleStateDTO {
  const id = r.module_id as ModuleId;
  return {
    moduleId: id,
    label: MODULE_BY_ID[id]?.label ?? id,
    position: r.position,
    status: r.status,
    attempt: r.attempt,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    durationMs: r.duration_ms,
    errorMessage: r.error_message,
    note: r.note,
    counts: { ...EMPTY_COUNTS, ...(r.counts ?? {}) } as ResultCounts,
  };
}

export function toResultDTO(r: any): ResultDTO {
  return {
    id: r.id,
    moduleId: r.module_id,
    category: r.category,
    checkKey: r.check_key,
    title: r.title,
    status: r.status,
    severity: r.severity,
    confidence: r.confidence,
    affectedUrl: r.affected_url || null,
    message: r.message,
    evidence: r.evidence,
    createdAt: iso(r.created_at)!,
  };
}

export function toBugDTO(r: any): BugDTO {
  return {
    id: r.id,
    issueCode: r.issue_code,
    jobId: r.job_id,
    category: r.category,
    severity: r.severity,
    confidence: r.confidence,
    title: r.title,
    description: r.description,
    affectedUrl: r.affected_url || null,
    evidence: r.evidence,
    environment: r.environment,
    suggestedFix: r.suggested_fix,
    aiAnalysis: r.ai_analysis ?? null,
    status: r.status,
    createdAt: iso(r.created_at)!,
  };
}

export function toLogDTO(r: any): LogDTO {
  return { id: Number(r.id), moduleId: r.module_id, level: r.level, message: r.message, createdAt: iso(r.created_at)! };
}
