import { describe, expect, it } from "vitest";
import { gateResult } from "@gb/gates";
import { isDue } from "../src/due.js";
import { stepRun } from "../src/machine.js";
import type { RunPatch, RunSnapshot, StepContext } from "../src/types.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function run(partial: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: RUN_ID,
    requestId: REQUEST_ID,
    requestText: "add a /status page",
    status: "active",
    phase: "queued",
    phaseReason: null,
    iteration: 0,
    version: 1,
    startedAt: NOW.toISOString(),
    deadlineAt: null,
    approved: [],
    executionMode: "simulation",
    evidenceReady: false,
    ...partial,
  };
}

function ctx(partial: Partial<StepContext> = {}): StepContext {
  return {
    now: NOW,
    config: { maxFixIterations: 3, maxAllowedIterations: 5, maxWallClockSeconds: 28_800 },
    jobState: null,
    gates: [],
    assertSpend: () => ({ ok: true }),
    ...partial,
  };
}

function apply(current: RunSnapshot, patch: RunPatch): RunSnapshot {
  return {
    ...current,
    status: patch.status,
    phase: patch.phase,
    phaseReason: patch.phaseReason,
    iteration: patch.iteration,
    deadlineAt: patch.deadlineAt,
    version: current.version + 1,
  };
}

describe("stepRun", () => {
  it("dispatches a planner from queued", () => {
    const outcome = stepRun(run(), ctx());
    expect(outcome.patch).toMatchObject({ status: "active", phase: "planning", iteration: 0 });
    expect(outcome.enqueue).toMatchObject({
      v: 1,
      name: "plan",
      role: "planner",
      runId: RUN_ID,
      requestId: REQUEST_ID,
      iteration: 0,
      requestText: "add a /status page",
    });
  });

  it("hard-stops before the planner job when the credit check fails", () => {
    const outcome = stepRun(
      run(),
      ctx({ assertSpend: () => ({ ok: false, message: "Credit hard stop: run cap exceeded" }) }),
    );
    expect(outcome.enqueue).toBeNull();
    expect(outcome.patch).toMatchObject({
      status: "needs_human",
      phase: "queued",
      phaseReason: "Credit hard stop: run cap exceeded",
    });
  });

  it("hard-stops when the wall clock is already past", () => {
    const outcome = stepRun(
      run({ startedAt: new Date(NOW.getTime() - 3_600_000).toISOString() }),
      ctx({
        config: { maxFixIterations: 3, maxAllowedIterations: 5, maxWallClockSeconds: 60 },
      }),
    );
    expect(outcome.enqueue).toBeNull();
    expect(outcome.patch).toMatchObject({ status: "needs_human", phaseReason: "wall_clock" });
  });

  it("ignores wall clock when the cap is disabled", () => {
    const outcome = stepRun(
      run({ startedAt: new Date(0).toISOString() }),
      ctx({
        config: { maxFixIterations: 3, maxAllowedIterations: 5, maxWallClockSeconds: 0 },
      }),
    );
    expect(outcome.patch?.phase).toBe("planning");
    expect(outcome.enqueue?.name).toBe("plan");
  });

  it("holds while the planner job is still in the queue", () => {
    expect(stepRun(run({ phase: "planning" }), ctx({ jobState: "waiting" }))).toEqual({
      patch: null,
      enqueue: null,
    });
    expect(stepRun(run({ phase: "planning" }), ctx({ jobState: "active" })).patch).toBeNull();
  });

  it("re-enqueues a missing planner job without a phase change", () => {
    const outcome = stepRun(run({ phase: "planning" }), ctx({ jobState: "missing" }));
    expect(outcome.patch).toBeNull();
    expect(outcome.enqueue?.name).toBe("plan");
  });

  it("parks on CP1 after planning until the gateway records the approval", () => {
    const waiting = stepRun(run({ phase: "planning" }), ctx({ jobState: "completed" }));
    expect(waiting.enqueue).toBeNull();
    expect(waiting.patch).toMatchObject({ status: "active", phase: "awaiting_cp1" });

    const still = stepRun(run({ phase: "awaiting_cp1" }), ctx());
    expect(still).toEqual({ patch: null, enqueue: null });
  });

  it("skips the CP1 wait when the human already approved, and does not skip gates for an early CP2", () => {
    const coded = stepRun(
      run({ phase: "planning", approved: ["CP1"] }),
      ctx({ jobState: "completed" }),
    );
    expect(coded.patch?.phase).toBe("coding");
    expect(coded.enqueue).toMatchObject({ name: "code", role: "coder" });

    const afterCode = stepRun(
      run({ phase: "coding", approved: ["CP1", "CP2"] }),
      ctx({ jobState: "completed" }),
    );
    expect(afterCode.patch?.phase).toBe("gates");
    expect(afterCode.enqueue).toBeNull();
  });

  it("does not declare success from stored CP3 until gates have passed and phase is awaiting_cp3", () => {
    const pass = [gateResult("unit", true, "ok")];
    const stillPlanning = stepRun(run({ phase: "queued", approved: ["CP1", "CP2", "CP3"] }), ctx());
    expect(stillPlanning.patch).toMatchObject({ status: "active", phase: "planning" });
    expect(stillPlanning.enqueue?.name).toBe("plan");

    const toCp2 = stepRun(run({ phase: "gates", approved: ["CP1"] }), ctx({ gates: pass }));
    expect(toCp2.patch).toMatchObject({ status: "active", phase: "awaiting_cp2" });

    const held = stepRun(run({ phase: "awaiting_cp2", approved: ["CP1"] }), ctx());
    expect(held.patch).toBeNull();

    const toCp3 = stepRun(run({ phase: "awaiting_cp2", approved: ["CP1", "CP2"] }), ctx());
    expect(toCp3.patch).toMatchObject({ status: "active", phase: "awaiting_cp3" });

    const afterGates = stepRun(
      run({ phase: "gates", approved: ["CP1", "CP2", "CP3"] }),
      ctx({ gates: pass }),
    );
    expect(afterGates.patch).toMatchObject({ status: "active", phase: "awaiting_cp3" });

    const simulated = stepRun(
      run({ phase: "awaiting_cp3", approved: ["CP1", "CP2", "CP3"] }),
      ctx(),
    );
    expect(simulated.patch).toMatchObject({
      status: "needs_human",
      phaseReason: "simulation_not_success",
    });
    const succeeded = stepRun(
      run({
        phase: "awaiting_cp3",
        approved: ["CP1", "CP2", "CP3"],
        executionMode: "live",
        evidenceReady: true,
      }),
      ctx(),
    );
    expect(succeeded.patch).toMatchObject({ status: "succeeded", phaseReason: "cp3_approved" });
  });

  it("retries a failed gate via decideFixLoop, then escalates at the cap", () => {
    const fail = [gateResult("unit", false, "nope")];
    let current = run({ phase: "gates", iteration: 0 });
    const fixes: number[] = [];
    for (let n = 0; n < 6; n += 1) {
      const outcome = stepRun(current, ctx({ gates: fail }));
      if (outcome.patch?.status === "escalated") {
        expect(outcome.enqueue).toBeNull();
        expect(outcome.patch.phaseReason).toBe("fix_loop_cap");
        expect(outcome.patch.iteration).toBe(3);
        expect(fixes).toEqual([1, 2, 3]);
        return;
      }
      expect(outcome.patch?.phase).toBe("fixing");
      expect(outcome.enqueue).toMatchObject({ name: "fix", role: "fixer" });
      fixes.push(outcome.patch?.iteration ?? -1);
      current = apply(current, outcome.patch!);
      const back = stepRun(current, ctx({ jobState: "completed" }));
      expect(back.patch?.phase).toBe("gates");
      current = apply(current, back.patch!);
    }
    throw new Error("fix loop did not escalate");
  });

  it("honors the lower of maxFixIterations and maxAllowedIterations", () => {
    const outcome = stepRun(
      run({ phase: "gates", iteration: 2 }),
      ctx({
        config: { maxFixIterations: 5, maxAllowedIterations: 2, maxWallClockSeconds: 28_800 },
        gates: [gateResult("lint", false, "nope")],
      }),
    );
    expect(outcome.patch?.status).toBe("escalated");
    expect(outcome.enqueue).toBeNull();
  });

  it("sends a failed coder job through the fixer, and a failed planner back to planning", () => {
    const roles: string[] = [];
    const coder = stepRun(
      run({ phase: "coding" }),
      ctx({
        jobState: "failed",
        assertSpend: (role) => {
          roles.push(role);
          return { ok: true };
        },
      }),
    );
    expect(roles).toEqual(["fixer"]);
    expect(coder.patch).toMatchObject({
      phase: "fixing",
      iteration: 1,
      phaseReason: "worker_job_failed",
    });
    expect(coder.enqueue?.name).toBe("fix");

    const planner = stepRun(run({ phase: "planning" }), ctx({ jobState: "failed" }));
    expect(planner.patch).toMatchObject({ phase: "planning", iteration: 1 });
    expect(planner.enqueue).toMatchObject({ name: "plan", role: "planner" });
  });

  it("hard-stops a fixer retry without enqueueing", () => {
    const outcome = stepRun(
      run({ phase: "gates" }),
      ctx({
        gates: [gateResult("unit", false, "nope")],
        assertSpend: () => ({ ok: false, message: "Credit hard stop: role cap exceeded" }),
      }),
    );
    expect(outcome.enqueue).toBeNull();
    expect(outcome.patch).toMatchObject({
      status: "needs_human",
      phase: "gates",
      phaseReason: "Credit hard stop: role cap exceeded",
    });
  });

  it("does not move a run the gateway already closed", () => {
    const outcome = stepRun(run({ status: "succeeded", phase: "queued" }), ctx());
    expect(outcome).toEqual({ patch: null, enqueue: null });
  });
});

describe("isDue", () => {
  const base = {
    status: "active" as const,
    phase: "queued" as const,
    approved: [] as const,
    leaseUntil: null,
  };

  it("claims active work and skips terminal rows and live leases", () => {
    expect(isDue(base, NOW)).toBe(true);
    expect(isDue({ ...base, status: "succeeded" }, NOW)).toBe(false);
    expect(isDue({ ...base, status: "needs_human" }, NOW)).toBe(false);
    expect(isDue({ ...base, leaseUntil: new Date(NOW.getTime() + 1_000).toISOString() }, NOW)).toBe(
      false,
    );
    expect(isDue({ ...base, leaseUntil: new Date(NOW.getTime() - 1_000).toISOString() }, NOW)).toBe(
      true,
    );
  });

  it("parks on a checkpoint until that approval exists", () => {
    expect(isDue({ ...base, phase: "awaiting_cp1", approved: [] }, NOW)).toBe(false);
    expect(isDue({ ...base, phase: "awaiting_cp1", approved: ["CP1"] }, NOW)).toBe(true);
    expect(isDue({ ...base, phase: "awaiting_cp2", approved: ["CP1"] }, NOW)).toBe(false);
    expect(isDue({ ...base, phase: "awaiting_cp2", approved: ["CP1", "CP2"] }, NOW)).toBe(true);
    expect(isDue({ ...base, phase: "awaiting_cp3", approved: ["CP1", "CP2"] }, NOW)).toBe(false);
    expect(isDue({ ...base, phase: "awaiting_cp3", approved: ["CP1", "CP2", "CP3"] }, NOW)).toBe(
      true,
    );
  });
});
