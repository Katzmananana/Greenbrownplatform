import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RUN_PHASES } from "@gb/shared";
import { CreditGuard, defaultLabOrgConfig } from "@gb/credits";
import { CLAIM_SQL, SAVE_SQL, rowToSnapshot } from "../src/postgres.js";
import { configFromOrgRow, ledgerFromSums } from "../src/credits.js";

describe("postgres lifecycle SQL", () => {
  const migration = readFileSync(
    new URL("../../../db/migrations/003_run_phase.sql", import.meta.url),
    "utf8",
  );

  it("keeps the migration, the claim predicate, and the CAS save on the phase list", () => {
    for (const phase of RUN_PHASES) {
      expect(migration).toContain(`'${phase}'`);
      expect(CLAIM_SQL).toContain(`'${phase}'`);
    }
    expect(CLAIM_SQL).toContain("SKIP LOCKED");
    expect(CLAIM_SQL).toContain("status = 'active'");
    expect(CLAIM_SQL).not.toContain("version =");
    expect(SAVE_SQL).toContain("version = $2");
    expect(SAVE_SQL).toContain("status = 'active'");
    expect(SAVE_SQL).not.toContain("approvals");
  });

  it("maps a runs row and drops an unknown phase", () => {
    const snapshot = rowToSnapshot(
      {
        id: "11111111-1111-4111-8111-111111111111",
        request_id: "22222222-2222-4222-8222-222222222222",
        status: "active",
        phase: "queued",
        phase_reason: null,
        iteration: "0",
        version: "3",
        started_at: new Date("2026-11-06T12:00:00.000Z"),
        deadline_at: null,
      },
      "add a /status page",
      ["CP1"],
    );
    expect(snapshot).toMatchObject({
      phase: "queued",
      iteration: 0,
      version: 3,
      requestText: "add a /status page",
      approved: ["CP1"],
      startedAt: "2026-11-06T12:00:00.000Z",
    });
    expect(
      rowToSnapshot({ ...{ phase: "nope", id: "x", request_id: "y", status: "active" } }, null, []),
    ).toBeNull();
  });
});

describe("credit preload", () => {
  it("hard-stops from preloaded sums without charging this run for other runs", () => {
    const config = defaultLabOrgConfig({
      maxCostUsd: 100,
      maxCostUsdPerRun: 10,
      perRoleBudgetUsd: { planner: 5 },
    });
    const ledger = ledgerFromSums(config.orgId, "run-1", {
      orgUsd: 40,
      runUsd: 6,
      byRole: [{ role: "planner", usd: 6 }],
    });
    const guard = new CreditGuard(config, ledger);
    expect(() =>
      guard.assertCanSpend({
        orgId: config.orgId,
        runId: "run-1",
        role: "planner",
        estimatedCostUsd: 0,
      }),
    ).toThrow(/role/);
    expect(ledger.sumRun("run-1")).toBe(6);
    expect(ledger.sumOrg(config.orgId)).toBe(40);
  });

  it("reads numeric org_config fields", () => {
    const config = configFromOrgRow({
      id: "cfg",
      org_id: "00000000-0000-4000-8000-000000000001",
      max_fix_iterations: "2",
      max_allowed_iterations: "4",
      max_cost_usd: "12.5",
      max_cost_usd_per_run: "3",
      per_role_budget_usd: { planner: "1.5", coder: 2 },
      credit_alert_pct: "75",
      max_wall_clock_seconds: "90",
      required_checks: ["unit", "lint"],
    });
    expect(config).toMatchObject({
      orgId: "00000000-0000-4000-8000-000000000001",
      maxFixIterations: 2,
      maxAllowedIterations: 4,
      maxCostUsd: 12.5,
      maxCostUsdPerRun: 3,
      creditAlertPct: 75,
      maxWallClockSeconds: 90,
      requiredChecks: ["unit", "lint"],
    });
    expect(config.perRoleBudgetUsd.planner).toBe(1.5);
  });
});
