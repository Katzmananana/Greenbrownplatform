import type { GateName, GateResult, OrgConfig } from "@gb/shared";

export interface GateContext {
  orgConfig: Pick<OrgConfig, "maxFixIterations" | "maxAllowedIterations" | "requiredChecks">;
  requirementText?: string;
  artifactText?: string;
  iteration?: number;
}

export interface GateRunner {
  run(name: GateName, ctx: GateContext): Promise<GateResult>;
}

export function gateResult(
  name: GateName | string,
  passed: boolean,
  message: string,
  extras: Partial<GateResult> = {},
): GateResult {
  return {
    name,
    status: "completed",
    conclusion: passed ? "success" : "failure",
    passed,
    message,
    ...extras,
  };
}
