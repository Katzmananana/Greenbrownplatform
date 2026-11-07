import {
  PHASE_FOR_CHECKPOINT,
  phaseAcceptsCheckpoint,
  type Checkpoint,
  type RunPhase,
  type RunStatus,
} from "@gb/shared";
import { type RunStage, RunStoreError } from "./types.js";

export const CHECKPOINT_ORDER: readonly Checkpoint[] = ["CP1", "CP2", "CP3"];

const STAGE_BY_NEXT: Record<Checkpoint, RunStage> = {
  CP1: "awaiting_cp1",
  CP2: "awaiting_cp2",
  CP3: "awaiting_cp3",
};

export function isCheckpoint(value: unknown): value is Checkpoint {
  return typeof value === "string" && (CHECKPOINT_ORDER as readonly string[]).includes(value);
}

/** The next checkpoint a human must approve, or null when all three are approved. */
export function nextCheckpoint(approved: Iterable<Checkpoint>): Checkpoint | null {
  const done = new Set(approved);
  return CHECKPOINT_ORDER.find((cp) => !done.has(cp)) ?? null;
}

export function stageFor(approved: Iterable<Checkpoint>): RunStage {
  const next = nextCheckpoint(approved);
  return next ? STAGE_BY_NEXT[next] : "approved";
}

/**
 * Checkpoints must be approved strictly in order (CP1, CP2, CP3), once each,
 * and only while the run is still active.
 */
export function assertCanApprove(
  run: {
    runId: string;
    status: RunStatus;
    phase: RunPhase;
    approved: Iterable<Checkpoint>;
  },
  checkpoint: Checkpoint,
): void {
  const approved = new Set(run.approved);
  if (approved.has(checkpoint)) {
    throw new RunStoreError(
      "already_approved",
      `${checkpoint} is already approved for run ${run.runId}`,
    );
  }
  if (run.status !== "active") {
    throw new RunStoreError(
      "run_not_active",
      `run ${run.runId} is ${run.status}; approvals require an active run`,
    );
  }
  const expected = nextCheckpoint(approved);
  if (expected !== checkpoint) {
    throw new RunStoreError(
      "out_of_order",
      `cannot approve ${checkpoint} for run ${run.runId}; next checkpoint is ${expected ?? "none"}`,
    );
  }
  if (!phaseAcceptsCheckpoint(run.phase, checkpoint)) {
    const required = PHASE_FOR_CHECKPOINT[checkpoint];
    throw new RunStoreError(
      "not_ready",
      `cannot approve ${checkpoint} for run ${run.runId}; orchestrator phase is ${run.phase}, required ${required}`,
    );
  }
}

/** CP3 is the last human gate: approving it closes the run as succeeded. */
export function statusAfterApproval(current: RunStatus, checkpoint: Checkpoint): RunStatus {
  return checkpoint === "CP3" ? "succeeded" : current;
}
