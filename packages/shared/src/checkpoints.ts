import { RUN_PHASES, type Checkpoint, type RunPhase } from "./types.js";

/** Orchestrator phase that must be current before a human may approve that checkpoint. */
export const PHASE_FOR_CHECKPOINT: Record<Checkpoint, RunPhase> = {
  CP1: "awaiting_cp1",
  CP2: "awaiting_cp2",
  CP3: "awaiting_cp3",
};

export function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === "string" && (RUN_PHASES as readonly string[]).includes(value);
}

/**
 * CP1 is the plan approval, CP2 the delivery approval, CP3 the promote approval.
 * None of them is accepted while earlier lifecycle work (plan, code, gates) is still outstanding.
 */
export function phaseAcceptsCheckpoint(phase: RunPhase, checkpoint: Checkpoint): boolean {
  return PHASE_FOR_CHECKPOINT[checkpoint] === phase;
}
