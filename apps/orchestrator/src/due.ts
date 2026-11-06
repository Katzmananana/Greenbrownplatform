import type { Checkpoint, RunPhase, RunStatus } from "@gb/shared";

const WAIT_FOR: Partial<Record<RunPhase, Checkpoint>> = {
  awaiting_cp1: "CP1",
  awaiting_cp2: "CP2",
  awaiting_cp3: "CP3",
};

/**
 * A run is due when it is still active, its lease is free, and it is not
 * parked on a human checkpoint. Waiting phases become due only after the
 * gateway has recorded that checkpoint — the loop never approves for the human.
 */
export function isDue(
  run: {
    status: RunStatus;
    phase: RunPhase;
    approved: readonly Checkpoint[];
    leaseUntil: string | null;
  },
  now: Date,
): boolean {
  if (run.status !== "active") return false;
  if (run.leaseUntil !== null) {
    const until = Date.parse(run.leaseUntil);
    if (Number.isFinite(until) && until > now.getTime()) return false;
  }
  const checkpoint = WAIT_FOR[run.phase];
  if (checkpoint) return run.approved.includes(checkpoint);
  return true;
}
