import { Queue } from "bullmq";
import {
  JOB_QUEUE_NAME,
  agentJobId,
  bullmqConnectionFromUrl,
  type AgentJobPayload,
} from "@gb/shared";
import type { JobDispatcher, JobState } from "./dispatcher.js";

const KEEP = { age: 86_400, count: 1_000 };

/**
 * Producer for the queue `apps/worker` consumes. Completion is read back from
 * BullMQ so the worker does not need a database connection.
 */
export function createBullDispatcher(redisUrl: string): JobDispatcher {
  const queue = new Queue<AgentJobPayload>(JOB_QUEUE_NAME, {
    connection: bullmqConnectionFromUrl(redisUrl),
  });

  return {
    async enqueue(payload: AgentJobPayload): Promise<void> {
      const jobId = agentJobId(payload);
      const existing = await queue.getJob(jobId);
      if (existing) return;
      try {
        await queue.add(payload.name, payload, {
          jobId,
          attempts: 1,
          removeOnComplete: KEEP,
          removeOnFail: KEEP,
        });
      } catch (err) {
        if (err instanceof Error && /already exists/i.test(err.message)) return;
        throw err;
      }
    },
    async state(job): Promise<JobState> {
      const existing = await queue.getJob(agentJobId(job));
      if (!existing) return "missing";
      const state = await existing.getState();
      if (state === "completed") return "completed";
      if (state === "failed") return "failed";
      if (state === "active") return "active";
      return "waiting";
    },
    async close(): Promise<void> {
      await queue.close();
    },
  };
}
