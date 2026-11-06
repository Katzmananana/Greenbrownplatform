import type { GateResult, OrgConfig } from "@gb/shared";
import { gateResult } from "@gb/gates";

/** Logic-only §7 results. No CI provider is called. */
export function evaluateStubGates(
  config: Pick<OrgConfig, "requiredChecks">,
  failNames: readonly string[],
): GateResult[] {
  const fail = new Set(failNames);
  const names = config.requiredChecks.length > 0 ? config.requiredChecks : ["unit"];
  return names.map((name) =>
    gateResult(
      name,
      !fail.has(name),
      fail.has(name) ? "stub gate failure" : "logic-only stub; CI not called",
    ),
  );
}
