/** Contract between the API (producer) and the worker (consumer). */
export const QUEUE_NAME = 'nba-test-jobs';

export interface TestJobPayload {
  /** Primary key of the row in public.test_jobs. The database is the source of truth. */
  jobId: string;
}

/**
 * BullMQ job options. The job id is the test job UUID, so enqueueing is idempotent:
 * adding the same test twice never produces two executions.
 */
export const QUEUE_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 3600 },
};

/** A module that has been attempted this many times without settling is marked failed (poison-module guard). */
export const MAX_MODULE_ATTEMPTS = 3;
