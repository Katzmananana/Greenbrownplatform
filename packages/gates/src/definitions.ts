import type { GateName } from "@gb/shared";

export interface GateDefinition {
  name: GateName;
  blocking: true;
  when: string;
  onFailure: string;
}

/** §7 / addendum v1.1 — every gate is blocking. Failure = no merge, no CP3. */
export const BLOCKING_GATES: readonly GateDefinition[] = [
  { name: "lint", blocking: true, when: "PR / VERIFYING", onFailure: "FIXING" },
  { name: "typecheck", blocking: true, when: "PR / VERIFYING", onFailure: "FIXING" },
  { name: "unit", blocking: true, when: "PR / VERIFYING", onFailure: "FIXING" },
  { name: "functional", blocking: true, when: "PR / VERIFYING", onFailure: "FIXING" },
  { name: "e2e", blocking: true, when: "PR / VERIFYING", onFailure: "FIXING" },
  { name: "reviewer", blocking: true, when: "VERIFYING", onFailure: "FIXING / NEEDS_HUMAN" },
  { name: "acceptance", blocking: true, when: "VERIFYING before EVALUATING", onFailure: "FIXING" },
  {
    name: "sast",
    blocking: true,
    when: "PR / VERIFYING",
    onFailure: "block; critical→NEEDS_HUMAN",
  },
  { name: "load_pr", blocking: true, when: "PR / VERIFYING", onFailure: "block" },
  {
    name: "load_staging",
    blocking: true,
    when: "after staging, before CP3",
    onFailure: "block CP3",
  },
  { name: "fix_loop", blocking: true, when: "after a gate failure", onFailure: "cap → ESCALATED" },
] as const;

export const BLOCKING_GATE_NAMES: readonly GateName[] = BLOCKING_GATES.map((g) => g.name);
