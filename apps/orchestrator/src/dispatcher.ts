import { agentJobId, type AgentJobPayload } from "@gb/shared";

export type JobState = "missing" | "waiting" | "active" | "completed" | "failed";

export interface JobDispatcher {
  enqueue(payload: AgentJobPayload): Promise<void>;
  state(job: Pick<AgentJobPayload, "name" | "runId" | "iteration">): Promise<JobState>;
  close(): Promise<void>;
}

interface StoredJob {
  payload: AgentJobPayload;
  state: JobState;
}

/** Test double and the no-Redis inline queue. Job ids match BullMQ. */
export class MemoryJobDispatcher implements JobDispatcher {
  readonly jobs = new Map<string, StoredJob>();

  constructor(private readonly autoComplete = false) {}

  async enqueue(payload: AgentJobPayload): Promise<void> {
    const id = agentJobId(payload);
    if (this.jobs.has(id)) return;
    this.jobs.set(id, {
      payload,
      state: this.autoComplete ? "completed" : "waiting",
    });
  }

  async state(job: Pick<AgentJobPayload, "name" | "runId" | "iteration">): Promise<JobState> {
    return this.jobs.get(agentJobId(job))?.state ?? "missing";
  }

  mark(job: Pick<AgentJobPayload, "name" | "runId" | "iteration">, state: JobState): void {
    const row = this.jobs.get(agentJobId(job));
    if (!row) throw new Error(`no job ${agentJobId(job)}`);
    row.state = state;
  }

  async close(): Promise<void> {}
}
