import type { Checkpoint, ExecutionMode, OrgConfig, RunPhase, RunStatus } from "@gb/shared";

/** Run row the lifecycle loop claims. `approved` is the gateway approval set. */
export interface RunSnapshot {
  id: string;
  requestId: string;
  requestText: string | null;
  status: RunStatus;
  phase: RunPhase;
  phaseReason: string | null;
  iteration: number;
  version: number;
  startedAt: string;
  deadlineAt: string | null;
  approved: readonly Checkpoint[];
  executionMode: ExecutionMode;
  /** True only when decideRunSuccess would accept this run. */
  evidenceReady: boolean;
}

/** Fields written by one successful transition. Version is bumped by the repo. */
export interface RunPatch {
  status: RunStatus;
  phase: RunPhase;
  phaseReason: string | null;
  iteration: number;
  deadlineAt: string | null;
}

export type SpendRole = "planner" | "coder" | "fixer";

export interface StepContext {
  now: Date;
  config: Pick<OrgConfig, "maxFixIterations" | "maxAllowedIterations" | "maxWallClockSeconds">;
  /** Null when this phase is not waiting on a worker job. */
  jobState: "missing" | "waiting" | "active" | "completed" | "failed" | null;
  gates: readonly { name: string; passed: boolean }[];
  assertSpend: (role: SpendRole) => { ok: true } | { ok: false; message: string };
}
