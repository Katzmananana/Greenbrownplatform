import type { OrgConfig } from "@gb/shared";

export const SECTION_7_GATES = [
  "lint",
  "typecheck",
  "unit",
  "functional",
  "e2e",
  "reviewer",
  "acceptance",
  "sast",
  "load_pr",
  "load_staging",
] as const;

export function defaultLabOrgConfig(overrides: Partial<OrgConfig> = {}): OrgConfig {
  return {
    id: "cfg-lab",
    orgId: "org-lab",
    maxFixIterations: 3,
    maxAllowedIterations: 5,
    maxCostUsd: 50,
    maxCostUsdPerRun: 10,
    perRoleBudgetUsd: {
      planner: 5,
      coder: 8,
      reviewer: 3,
      fixer: 5,
      reporter: 2,
    },
    creditAlertPct: 80,
    maxWallClockSeconds: 28800,
    timeouts: {},
    notify: {},
    codingAgent: "cursor",
    models: {
      intake: { provider: "xai", model: "grok-4" },
      planner: { provider: "xai", model: "grok-4" },
      reviewer: { provider: "anthropic", model: "claude-sonnet-4" },
      reporter: { provider: "xai", model: "grok-4" },
      fixer: { provider: "xai", model: "grok-4" },
      fallback: { provider: "anthropic", model: "claude-sonnet-4" },
    },
    allowSelfApproval: true,
    protectedPaths: [".github/**", "infra/**"],
    requiredChecks: [...SECTION_7_GATES],
    requireProdApproval: true,
    updatedAt: new Date(0).toISOString(),
    updatedBy: null,
    ...overrides,
  };
}
