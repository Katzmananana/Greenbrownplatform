import type { Checkpoint, RunPhase, RunStatus } from "@gb/shared";

/** Where a run sits in the CP1 → CP2 → CP3 human-checkpoint sequence. */
export type RunStage = "awaiting_cp1" | "awaiting_cp2" | "awaiting_cp3" | "approved";

export interface ApprovalRecord {
  checkpoint: Checkpoint;
  decision: "approved";
  userId: string;
  comment: string | null;
  at: string;
}

export interface RunRecord {
  runId: string;
  requestId: string;
  request: string | null;
  status: RunStatus;
  /** Orchestrator lifecycle. Distinct from `stage`, which is the next human checkpoint. */
  phase: RunPhase;
  stage: RunStage;
  iteration: number;
  version: number;
  startedAt: string;
  endedAt: string | null;
  approvals: ApprovalRecord[];
}

export interface CreateRunInput {
  request: string;
}

export interface ApproveInput {
  runId: string;
  checkpoint: Checkpoint;
  userId: string;
  comment?: string | null;
  ip?: string | null;
}

export interface RunStore {
  readonly kind: "memory" | "postgres";
  createRun(input: CreateRunInput): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  approve(input: ApproveInput): Promise<RunRecord>;
  close?(): Promise<void>;
}

export type RunStoreErrorCode =
  | "not_found"
  | "out_of_order"
  | "already_approved"
  | "run_not_active"
  | "not_ready";

export class RunStoreError extends Error {
  readonly code: RunStoreErrorCode;

  constructor(code: RunStoreErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "RunStoreError";
  }
}
