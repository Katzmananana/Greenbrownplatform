import type { OrgConfig } from "@gb/shared";

export type FixLoopAction = "retry" | "escalate";

export interface FixLoopDecision {
  action: FixLoopAction;
  iteration: number;
  nextIteration: number;
  maxFixIterations: number;
  maxAllowedIterations: number;
  reason?: string;
}

/**
 * After a blocking gate fails, retry until org_config.max_fix_iterations
 * (also bounded by max_allowed_iterations). Cap → ESCALATED / NEEDS_HUMAN.
 */
export function decideFixLoop(
  config: Pick<OrgConfig, "maxFixIterations" | "maxAllowedIterations">,
  currentIteration: number,
): FixLoopDecision {
  const cap = Math.min(config.maxFixIterations, config.maxAllowedIterations);
  const nextIteration = currentIteration + 1;
  if (nextIteration > cap) {
    return {
      action: "escalate",
      iteration: currentIteration,
      nextIteration,
      maxFixIterations: config.maxFixIterations,
      maxAllowedIterations: config.maxAllowedIterations,
      reason: "fix_loop_cap",
    };
  }
  return {
    action: "retry",
    iteration: currentIteration,
    nextIteration,
    maxFixIterations: config.maxFixIterations,
    maxAllowedIterations: config.maxAllowedIterations,
  };
}
