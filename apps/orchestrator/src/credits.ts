import type { AgentRole, CreditLedgerEntry, OrgConfig } from "@gb/shared";
import { InMemoryCreditLedger, defaultLabOrgConfig } from "@gb/credits";

export interface SpendSums {
  orgUsd: number;
  runUsd: number;
  byRole: { role: string; usd: number }[];
}

/**
 * CreditGuard's ledger is synchronous, so the loop preloads sums into memory
 * before `assertCanSpend`. Stub agents do not append new rows.
 */
export function ledgerFromSums(
  orgId: string,
  runId: string,
  sums: SpendSums,
): InMemoryCreditLedger {
  const ledger = new InMemoryCreditLedger();
  let roleAccounted = 0;
  let index = 0;
  for (const row of sums.byRole) {
    if (!(row.usd > 0)) continue;
    roleAccounted += row.usd;
    ledger.append(entry(orgId, runId, row.role, row.usd, `role-${index}`));
    index += 1;
  }
  const runGap = sums.runUsd - roleAccounted;
  if (runGap > 0) {
    ledger.append(entry(orgId, runId, "reporter", runGap, "run-gap"));
  }
  const accountedRun = roleAccounted + Math.max(0, runGap);
  const orgGap = sums.orgUsd - accountedRun;
  if (orgGap > 0) {
    ledger.append(entry(orgId, `${runId}:other`, "reporter", orgGap, "org-gap"));
  }
  return ledger;
}

function entry(
  orgId: string,
  runId: string,
  role: AgentRole | string,
  costUsd: number,
  id: string,
): CreditLedgerEntry {
  return {
    id,
    orgId,
    requestId: null,
    runId,
    role,
    provider: "ledger",
    model: "sum",
    inTokens: 0,
    outTokens: 0,
    costUsd,
    reason: "sum",
    createdAt: new Date(0).toISOString(),
  };
}

export function configFromOrgRow(row: Record<string, unknown>): OrgConfig {
  const base = defaultLabOrgConfig();
  return {
    ...base,
    id: String(row.id ?? base.id),
    orgId: String(row.org_id ?? base.orgId),
    maxFixIterations: num(row.max_fix_iterations, base.maxFixIterations),
    maxAllowedIterations: num(row.max_allowed_iterations, base.maxAllowedIterations),
    maxCostUsd: num(row.max_cost_usd, base.maxCostUsd),
    maxCostUsdPerRun: num(row.max_cost_usd_per_run, base.maxCostUsdPerRun),
    perRoleBudgetUsd: roleBudgets(row.per_role_budget_usd, base.perRoleBudgetUsd),
    creditAlertPct: num(row.credit_alert_pct, base.creditAlertPct),
    maxWallClockSeconds: num(row.max_wall_clock_seconds, base.maxWallClockSeconds),
    codingAgent: row.coding_agent == null ? base.codingAgent : String(row.coding_agent),
    allowSelfApproval:
      typeof row.allow_self_approval === "boolean"
        ? row.allow_self_approval
        : base.allowSelfApproval,
    requireProdApproval:
      typeof row.require_prod_approval === "boolean"
        ? row.require_prod_approval
        : base.requireProdApproval,
    protectedPaths: stringList(row.protected_paths, base.protectedPaths),
    requiredChecks: stringList(row.required_checks, base.requiredChecks),
    updatedAt: toIso(row.updated_at) ?? base.updatedAt,
    updatedBy: row.updated_by == null ? null : String(row.updated_by),
  };
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.map((item) => String(item));
}

function roleBudgets(
  value: unknown,
  fallback: OrgConfig["perRoleBudgetUsd"],
): OrgConfig["perRoleBudgetUsd"] {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return fallback;
    }
  }
  if (typeof raw !== "object" || raw === null) return fallback;
  const out: OrgConfig["perRoleBudgetUsd"] = {};
  for (const [key, amount] of Object.entries(raw)) {
    const n = typeof amount === "number" ? amount : Number(amount);
    if (Number.isFinite(n)) out[key as AgentRole] = n;
  }
  return out;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}
