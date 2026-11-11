import type {
  CheckCategory,
  Confidence,
  JobStatus,
  ModuleId,
  ModuleStatus,
  ResultStatus,
  Severity,
} from './constants.js';

export type OverallResult = 'issues_found' | 'warnings_only' | 'no_issues_detected' | 'incomplete';

export interface ResultCounts {
  pass: number;
  fail: number;
  warning: number;
  info: number;
  skipped: number;
  blocked: number;
}

export const EMPTY_COUNTS: Readonly<ResultCounts> = {
  pass: 0,
  fail: 0,
  warning: 0,
  info: 0,
  skipped: 0,
  blocked: 0,
};

export interface JobSummary {
  counts: ResultCounts;
  bugs: number;
  overall: OverallResult;
  /** True if at least one module could not run or was unavailable. */
  incomplete: boolean;
  generatedAt: string;
}

export interface JobDTO {
  id: string;
  targetUrl: string;
  hostname: string;
  status: JobStatus;
  progressPct: number;
  currentModule: ModuleId | null;
  lastCompletedModule: ModuleId | null;
  selectedModules: ModuleId[];
  attempt: number;
  errorMessage: string | null;
  cancelRequested: boolean;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  updatedAt: string;
  summary: JobSummary | null;
}

export interface ModuleStateDTO {
  moduleId: ModuleId;
  label: string;
  position: number;
  status: ModuleStatus;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  /** Human-readable reason for skipped / blocked modules. */
  note: string | null;
  counts: ResultCounts;
}

export interface ResultDTO {
  id: string;
  moduleId: ModuleId;
  category: CheckCategory;
  checkKey: string;
  title: string;
  status: ResultStatus;
  severity: Severity | null;
  confidence: Confidence | null;
  affectedUrl: string | null;
  message: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface BugDTO {
  id: string;
  issueCode: string;
  jobId: string;
  category: CheckCategory;
  severity: Severity;
  confidence: Confidence;
  title: string;
  description: string;
  affectedUrl: string | null;
  evidence: Record<string, unknown>;
  environment: Record<string, unknown>;
  suggestedFix: string;
  /** AI output is stored separately from raw evidence. */
  aiAnalysis: Record<string, unknown> | null;
  status: 'open' | 'resolved' | 'ignored';
  createdAt: string;
}

export interface LogDTO {
  id: number;
  moduleId: ModuleId | null;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  createdAt: string;
}

export interface ProgressDTO {
  job: JobDTO;
  modules: ModuleStateDTO[];
  counts: ResultCounts;
  logs: LogDTO[];
  /** Highest log id included; pass back as `after` to continue from here. */
  logCursor: number;
  serverTime: string;
}

export interface ReportDTO {
  job: JobDTO;
  modules: ModuleStateDTO[];
  results: ResultDTO[];
  bugs: BugDTO[];
  summary: JobSummary;
  message: string;
}

/** Output of a single check as produced by a worker module. */
export interface CheckOutcome {
  checkKey: string;
  title: string;
  status: ResultStatus;
  severity?: Severity;
  confidence?: Confidence;
  affectedUrl?: string | null;
  message: string;
  evidence?: Record<string, unknown>;
  /** Used to create the bug report's suggested fix for fail / warning outcomes. */
  recommendation?: string;
}
