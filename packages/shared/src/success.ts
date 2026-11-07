export type ExecutionMode = "simulation" | "live";

export type SuccessBlock = "simulation_not_success" | "evidence_missing";

/**
 * Real success requires a live execution, one artifact for the run's commit,
 * and a verified pass of every required gate for that same commit.
 * Simulation is never success, even when a human has approved CP3.
 */
export function decideRunSuccess(input: {
  executionMode: ExecutionMode;
  commitSha: string | null;
  artifactCommitSha: string | null;
  verifiedPassedGates: readonly string[];
  requiredGates: readonly string[];
}): { ok: true } | { ok: false; reason: SuccessBlock } {
  if (input.executionMode !== "live") {
    return { ok: false, reason: "simulation_not_success" };
  }
  const sha = input.commitSha?.trim() ?? "";
  if (!sha || input.artifactCommitSha !== sha) {
    return { ok: false, reason: "evidence_missing" };
  }
  if (input.requiredGates.length === 0) {
    return { ok: false, reason: "evidence_missing" };
  }
  const verified = new Set(input.verifiedPassedGates);
  if (input.requiredGates.some((gate) => !verified.has(gate))) {
    return { ok: false, reason: "evidence_missing" };
  }
  return { ok: true };
}
