import { randomUUID } from "node:crypto";
import { decideRunSuccess, type ExecutionMode, type RunPhase } from "@gb/shared";
import type { ApproveInput, CreateRunInput, RunRecord, RunStore } from "./types.js";
import { RunStoreError } from "./types.js";
import { assertCanApprove, stageFor, statusAfterApproval } from "./workflow.js";

type StoredRun = Omit<RunRecord, "stage">;

/** Process-local run store for local dev and tests (used when DATABASE_URL is unset). */
export class InMemoryRunStore implements RunStore {
  readonly kind = "memory" as const;
  private readonly runs = new Map<string, StoredRun>();
  private readonly evidence = new Map<
    string,
    {
      artifactCommitSha: string;
      verifiedPassedGates: string[];
      requiredGates: string[];
    }
  >();

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const run: StoredRun = {
      runId: randomUUID(),
      requestId: randomUUID(),
      request: input.request,
      status: "active",
      phase: "queued",
      phaseReason: null,
      executionMode: "simulation",
      commitSha: null,
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
    if (!input.userId.trim() || !input.authTime) {
      throw new RunStoreError(
        "human_auth_required",
        "approve requires a verified human user id and auth_time",
      );
    }
    assertCanApprove(
      {
        runId: run.runId,
        status: run.status,
        phase: run.phase,
        approved: run.approvals.map((a) => a.checkpoint),
      },
      input.checkpoint,
    );
    const at = input.authTime;
    run.approvals.push({
      checkpoint: input.checkpoint,
      decision: "approved",
      userId: input.userId,
      comment: input.comment ?? null,
      at,
    });
    const success = this.successFor(run);
    run.status = statusAfterApproval(run.status, input.checkpoint, success.ok);
    if (input.checkpoint === "CP3" && !success.ok) run.phaseReason = success.reason;
    if (input.checkpoint === "CP3" && success.ok) run.phaseReason = "cp3_approved";
    if (run.status !== "active") run.endedAt = at;
    run.version += 1;
    return view(run);
  }

  /** Test fixture only. The stub orchestrator never flips a run to live. */
  setLiveEvidence(
    runId: string,
    input: { commitSha: string; requiredGates: readonly string[] },
  ): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    run.executionMode = "live";
    run.commitSha = input.commitSha;
    this.evidence.set(runId, {
      artifactCommitSha: input.commitSha,
      verifiedPassedGates: [...input.requiredGates],
      requiredGates: [...input.requiredGates],
    });
  }

  /**
   * Test fixture for the phase the orchestrator would have saved.
   * Does not bump version and is not an MCP operation.
   */
  setPhase(runId: string, phase: RunPhase): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    run.phase = phase;
  }

  private successFor(run: StoredRun): { ok: true } | { ok: false; reason: string } {
    const evidence = this.evidence.get(run.runId);
    return decideRunSuccess({
      executionMode: run.executionMode,
      commitSha: run.commitSha,
      artifactCommitSha: evidence?.artifactCommitSha ?? null,
      verifiedPassedGates: evidence?.verifiedPassedGates ?? [],
      requiredGates: evidence?.requiredGates ?? [],
    });
  }
}

function view(run: StoredRun): RunRecord {
  return {
    ...run,
    approvals: run.approvals.map((a) => ({ ...a })),
    stage: stageFor(run.approvals.map((a) => a.checkpoint)),
  };
}
