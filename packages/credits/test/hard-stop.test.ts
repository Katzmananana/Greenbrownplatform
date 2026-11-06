import { describe, expect, it } from "vitest";
import type { CreditAlert } from "@gb/shared";
import {
  CreditGuard,
  CreditHardStopError,
  defaultLabOrgConfig,
  InMemoryCreditLedger,
} from "../src/index.js";

function makeGuard(overrides: Parameters<typeof defaultLabOrgConfig>[0] = {}) {
  const alerts: CreditAlert[] = [];
  const ledger = new InMemoryCreditLedger();
  const config = defaultLabOrgConfig({
    maxCostUsd: 10,
    maxCostUsdPerRun: 5,
    perRoleBudgetUsd: { planner: 3, coder: 4, reviewer: 2, fixer: 3, reporter: 1 },
    creditAlertPct: 80,
    ...overrides,
  });
  const guard = new CreditGuard(config, ledger, (a) => alerts.push(a));
  return { guard, ledger, alerts, config };
}

const base = {
  orgId: "org-lab",
  runId: "run-1",
  requestId: "req-1",
  role: "coder" as const,
  provider: "xai",
  model: "grok-4",
};

const wideCaps = {
  maxCostUsd: 100,
  maxCostUsdPerRun: 100,
  perRoleBudgetUsd: { planner: 100, coder: 100, reviewer: 100, fixer: 100, reporter: 100 },
};

describe("CreditGuard hard stop and alerts", () => {
  it("allows spend under org, run, and role caps", async () => {
    const { guard, ledger } = makeGuard();
    const result = await guard.completeWithCreditGuard(
      { ...base, estimatedCostUsd: 1.5 },
      async () => "ok",
    );
    expect(result).toBe("ok");
    expect(ledger.sumOrg("org-lab")).toBe(1.5);
    expect(ledger.sumRun("run-1")).toBe(1.5);
  });

  it("emits a 80% alert when org spend crosses the threshold", () => {
    const { guard, alerts } = makeGuard(wideCaps);
    guard.assertCanSpend({ ...base, estimatedCostUsd: 80 });
    expect(alerts.some((a) => a.scope === "org")).toBe(true);
    const orgAlert = alerts.find((a) => a.scope === "org");
    expect(orgAlert?.type).toBe("credit_alert");
    expect(orgAlert?.alertPct).toBe(80);
    expect(orgAlert?.pct).toBeGreaterThanOrEqual(80);
  });

  it("emits a 80% alert when run spend crosses the threshold", () => {
    const { guard, alerts } = makeGuard({ ...wideCaps, maxCostUsdPerRun: 5 });
    guard.assertCanSpend({ ...base, estimatedCostUsd: 4 });
    expect(alerts.some((a) => a.scope === "run")).toBe(true);
    expect(alerts.find((a) => a.scope === "run")?.pct).toBeGreaterThanOrEqual(80);
  });

  it("emits a 80% alert when a role budget crosses the threshold", () => {
    const { guard, alerts } = makeGuard({
      ...wideCaps,
      perRoleBudgetUsd: { planner: 100, coder: 100, reviewer: 2, fixer: 100, reporter: 100 },
    });
    guard.assertCanSpend({ ...base, role: "reviewer", estimatedCostUsd: 1.6 });
    const roleAlert = alerts.find((a) => a.scope === "role");
    expect(roleAlert).toBeDefined();
    expect(roleAlert?.role).toBe("reviewer");
    expect(roleAlert?.pct).toBeGreaterThanOrEqual(80);
  });

  it("hard-stops at the org cap and does not call the LLM", async () => {
    const { guard, ledger } = makeGuard(wideCaps);
    guard.recordSpend({ ...base, estimatedCostUsd: 95 });
    let called = false;
    await expect(
      guard.completeWithCreditGuard({ ...base, estimatedCostUsd: 6 }, async () => {
        called = true;
        return "secret";
      }),
    ).rejects.toMatchObject({
      name: "CreditHardStopError",
      code: "credit_hard_stop",
      scope: "org",
      escalation: "NEEDS_HUMAN",
    });
    expect(called).toBe(false);
    expect(ledger.sumOrg("org-lab")).toBe(95);
  });

  it("hard-stops at the per-run cap", () => {
    const { guard } = makeGuard({ ...wideCaps, maxCostUsdPerRun: 5 });
    guard.recordSpend({ ...base, estimatedCostUsd: 4.2 });
    expect(() => guard.assertCanSpend({ ...base, estimatedCostUsd: 1 })).toThrow(
      CreditHardStopError,
    );
    try {
      guard.assertCanSpend({ ...base, estimatedCostUsd: 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(CreditHardStopError);
      expect((err as CreditHardStopError).scope).toBe("run");
      expect((err as CreditHardStopError).capUsd).toBe(5);
    }
  });

  it("hard-stops at the per-role cap", () => {
    const { guard } = makeGuard({
      ...wideCaps,
      perRoleBudgetUsd: { planner: 3, coder: 100, reviewer: 100, fixer: 100, reporter: 100 },
    });
    guard.recordSpend({ ...base, role: "planner", estimatedCostUsd: 2.5 });
    expect(() => guard.assertCanSpend({ ...base, role: "planner", estimatedCostUsd: 0.6 })).toThrow(
      CreditHardStopError,
    );
    try {
      guard.assertCanSpend({ ...base, role: "planner", estimatedCostUsd: 0.6 });
    } catch (err) {
      expect((err as CreditHardStopError).scope).toBe("role");
      expect((err as CreditHardStopError).role).toBe("planner");
    }
  });

  it("does not let a second call bypass after the cap is hit", async () => {
    const { guard } = makeGuard({
      maxCostUsd: 10,
      maxCostUsdPerRun: 10,
      perRoleBudgetUsd: { planner: 10, coder: 10, reviewer: 10, fixer: 10, reporter: 10 },
    });
    await guard.completeWithCreditGuard({ ...base, estimatedCostUsd: 10 }, async () => "at-cap");
    let bypass = false;
    await expect(
      guard.completeWithCreditGuard({ ...base, estimatedCostUsd: 0.01 }, async () => {
        bypass = true;
        return "bypass";
      }),
    ).rejects.toBeInstanceOf(CreditHardStopError);
    expect(bypass).toBe(false);
  });

  it("allows spending exactly up to the cap", () => {
    const { guard } = makeGuard({
      maxCostUsd: 10,
      maxCostUsdPerRun: 10,
      perRoleBudgetUsd: { planner: 10, coder: 10, reviewer: 10, fixer: 10, reporter: 10 },
    });
    expect(() => guard.assertCanSpend({ ...base, estimatedCostUsd: 10 })).not.toThrow();
  });
});
