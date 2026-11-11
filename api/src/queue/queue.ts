import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_JOB_OPTIONS, QUEUE_NAME, type TestJobPayload } from '@nba/shared';

export interface JobQueue {
  enqueue(jobId: string): Promise<void>;
  /** Remove a not-yet-started job from the queue (best effort; the database is the source of truth). */
  remove(jobId: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createJobQueue(redisUrl: string): JobQueue {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null, enableOfflineQueue: true });
  const queue = new Queue<TestJobPayload>(QUEUE_NAME, { connection });
  return {
    async enqueue(jobId) {
      // The queue job id equals the test job id: enqueueing twice never creates two executions.
      const existing = await queue.getJob(jobId);
      const state = existing ? await existing.getState() : null;
      if (state === 'active' || state === 'waiting' || state === 'delayed') return;
      if (existing) await existing.remove().catch(() => undefined);
      await queue.add('run', { jobId }, { ...QUEUE_JOB_OPTIONS, jobId });
    },
    async remove(jobId) {
      const job = await queue.getJob(jobId);
      if (job) await job.remove().catch(() => undefined);
    },
    async ping() {
      try {
        return (await connection.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
    async close() {
      await queue.close().catch(() => undefined);
      await connection.quit().catch(() => undefined);
    },
  };
}
