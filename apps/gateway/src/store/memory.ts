import { randomUUID } from "node:crypto";
import type { ApproveInput, CreateRunInput, RunRecord, RunStore } from "./types.js";
import { RunStoreError } from "./types.js";
import { assertCanApprove, stageFor, statusAfterApproval } from "./workflow.js";

type StoredRun = Omit<RunRecord, "stage">;

/** Process-local run store for local dev and tests (used when DATABASE_URL is unset). */
export class InMemoryRunStore implements RunStore {
  readonly kind = "memory" as const;
  private readonly runs = new Map<string, StoredRun>();

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const run: StoredRun = {
      runId: randomUUID(),
      requestId: randomUUID(),
      request: input.request,
      status: "active",
      iteration: 0,
      version: 1,
      startedAt: new Date().toISOString(),
      endedAt: null,
      approvals: [],
    };
    this.runs.set(run.runId, run);
    return view(run);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    return run ? view(run) : null;
  }

  async approve(input: ApproveInput): Promise<RunRecord> {
    const run = this.runs.get(input.runId);
    if (!run) {
      throw new RunStoreError("not_found", `run ${input.runId} not found`);
    }
    assertCanApprove(
      { runId: run.runId, status: run.status, approved: run.approvals.map((a) => a.checkpoint) },
      input.checkpoint,
    );
    const at = new Date().toISOString();
    run.approvals.push({
      checkpoint: input.checkpoint,
      decision: "approved",
      userId: input.userId,
      comment: input.comment ?? null,
      at,
    });
    run.status = statusAfterApproval(run.status, input.checkpoint);
    if (run.status !== "active") run.endedAt = at;
    run.version += 1;
    return view(run);
  }
}

function view(run: StoredRun): RunRecord {
  return {
    ...run,
    approvals: run.approvals.map((a) => ({ ...a })),
    stage: stageFor(run.approvals.map((a) => a.checkpoint)),
  };
}
