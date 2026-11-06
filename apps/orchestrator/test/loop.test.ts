import { describe, expect, it } from "vitest";
import { InMemoryCreditLedger, defaultLabOrgConfig } from "@gb/credits";
import { gateResult } from "@gb/gates";
import { agentJobId } from "@gb/shared";
import { statusAfterApproval } from "../../gateway/src/store/workflow.js";
import { handleAgentJob } from "../../worker/src/handle.js";
import { MemoryJobDispatcher } from "../src/dispatcher.js";
import { runTick } from "../src/loop.js";
import { MemoryRunRepository } from "../src/repo.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

function harness(repo = new MemoryRunRepository()) {
  const jobs = new MemoryJobDispatcher();
  const tick = (
    gateRunner?: (run: unknown, config: unknown) => { name: string; passed: boolean }[],
  ) =>
    runTick({
      repo,
      jobs,
      now: NOW,
      leaseSeconds: 30,
      batchSize: 10,
      estimateUsd: 0,
      ...(gateRunner ? { gateRunner: gateRunner as never } : {}),
    });
  return { repo, jobs, tick };
}

function seed(
  repo: MemoryRunRepository,
  partial: Parameters<MemoryRunRepository["seed"]>[0] = {
    id: RUN_ID,
    requestId: REQUEST_ID,
  },
) {
  return repo.seed({
    id: RUN_ID,
    requestId: REQUEST_ID,
    requestText: "add a /status page",
    startedAt: NOW.toISOString(),
    ...partial,
  });
}

describe("run lifecycle loop", () => {
  it("hands plan and code payloads to the worker handler and waits for gateway approvals", async () => {
    const { repo, jobs, tick } = harness();
    seed(repo);

    expect((await tick()).enqueued).toBe(1);
    expect(repo.get(RUN_ID)?.phase).toBe("planning");
    const plan = jobs.jobs.get(agentJobId({ name: "plan", runId: RUN_ID, iteration: 0 }));
    expect(plan?.payload).toMatchObject({
      name: "plan",
      role: "planner",
      requestText: "add a /status page",
    });
    expect(handleAgentJob("plan", plan?.payload)).toMatchObject({
      ok: true,
      stub: true,
      name: "plan",
      runId: RUN_ID,
      iteration: 0,
      role: "planner",
    });
    jobs.mark({ name: "plan", runId: RUN_ID, iteration: 0 }, "completed");

    expect((await tick()).saved).toBe(1);
    expect(repo.get(RUN_ID)?.phase).toBe("awaiting_cp1");
    expect((await tick()).claimed).toBe(0);

    repo.recordGatewayApproval(RUN_ID, "CP1");
    expect(repo.get(RUN_ID)?.status).toBe(statusAfterApproval("active", "CP1"));
    expect((await tick()).enqueued).toBe(1);
    expect(repo.get(RUN_ID)?.phase).toBe("coding");

    const code = jobs.jobs.get(agentJobId({ name: "code", runId: RUN_ID, iteration: 0 }));
    expect(handleAgentJob("code", code?.payload).role).toBe("coder");
    jobs.mark({ name: "code", runId: RUN_ID, iteration: 0 }, "completed");
    expect((await tick()).saved).toBe(1);
    expect(repo.get(RUN_ID)?.phase).toBe("gates");

    expect((await tick()).saved).toBe(1);
    expect(repo.get(RUN_ID)?.phase).toBe("awaiting_cp2");
    expect((await tick()).claimed).toBe(0);

    repo.recordGatewayApproval(RUN_ID, "CP2");
    expect((await tick()).saved).toBe(1);
    expect(repo.get(RUN_ID)).toMatchObject({ phase: "awaiting_cp3", status: "active" });

    repo.recordGatewayApproval(RUN_ID, "CP3");
    expect(repo.get(RUN_ID)?.status).toBe("succeeded");
    expect((await tick()).claimed).toBe(0);
    expect(repo.get(RUN_ID)?.phase).toBe("awaiting_cp3");
  });

  it("still plans when CP1 arrived early, then codes without parking", async () => {
    const { repo, jobs, tick } = harness();
    seed(repo);
    repo.recordGatewayApproval(RUN_ID, "CP1");

    await tick();
    expect(repo.get(RUN_ID)?.phase).toBe("planning");
    jobs.mark({ name: "plan", runId: RUN_ID, iteration: 0 }, "completed");
    await tick();
    expect(repo.get(RUN_ID)?.phase).toBe("coding");
    expect(jobs.jobs.has(agentJobId({ name: "code", runId: RUN_ID, iteration: 0 }))).toBe(true);
  });

  it("does not enqueue when gateway CP3 commits before the transition save", async () => {
    const { repo, jobs, tick } = harness();
    seed(repo);
    const original = repo.save.bind(repo);
    repo.save = async (prev, patch) => {
      repo.recordGatewayApproval(prev.id, "CP1");
      repo.recordGatewayApproval(prev.id, "CP2");
      repo.recordGatewayApproval(prev.id, "CP3");
      return original(prev, patch);
    };

    const stats = await tick();
    expect(stats).toMatchObject({ conflicts: 1, enqueued: 0, saved: 0 });
    expect(repo.get(RUN_ID)).toMatchObject({ status: "succeeded", phase: "queued" });
    expect(jobs.jobs.size).toBe(0);
  });

  it("stops an already over-budget run before enqueueing", async () => {
    const { repo, jobs, tick } = harness();
    const config = defaultLabOrgConfig({ maxCostUsdPerRun: 10 });
    repo.config = config;
    seed(repo);
    const ledger = new InMemoryCreditLedger();
    ledger.append({
      id: "led-over",
      orgId: config.orgId,
      requestId: REQUEST_ID,
      runId: RUN_ID,
      role: "planner",
      provider: "ledger",
      model: "sum",
      inTokens: 0,
      outTokens: 0,
      costUsd: 20,
      reason: "sum",
      createdAt: NOW.toISOString(),
    });
    repo.setLedger(RUN_ID, ledger);

    const stats = await tick();
    expect(stats.enqueued).toBe(0);
    expect(repo.get(RUN_ID)).toMatchObject({ status: "needs_human", phase: "queued" });
    expect(repo.get(RUN_ID)?.phaseReason).toMatch(/run/);
    expect(jobs.jobs.size).toBe(0);
  });

  it("applies decideFixLoop until the cap, then escalates", async () => {
    const { repo, jobs, tick } = harness();
    repo.config = defaultLabOrgConfig({ maxFixIterations: 1, maxAllowedIterations: 1 });
    seed(repo, { id: RUN_ID, requestId: REQUEST_ID, phase: "gates", iteration: 0 });
    const failing = () => [gateResult("unit", false, "nope")];

    expect((await tick(failing)).enqueued).toBe(1);
    expect(repo.get(RUN_ID)).toMatchObject({ phase: "fixing", iteration: 1, status: "active" });
    const fix = jobs.jobs.get(agentJobId({ name: "fix", runId: RUN_ID, iteration: 1 }));
    expect(handleAgentJob("fix", fix?.payload)).toMatchObject({
      name: "fix",
      role: "fixer",
      iteration: 1,
    });
    jobs.mark({ name: "fix", runId: RUN_ID, iteration: 1 }, "completed");

    expect((await tick(failing)).saved).toBe(1);
    expect(repo.get(RUN_ID)?.phase).toBe("gates");
    const escalated = await tick(failing);
    expect(escalated.enqueued).toBe(0);
    expect(repo.get(RUN_ID)).toMatchObject({ status: "escalated", phaseReason: "fix_loop_cap" });
  });

  it("does not claim a checkpoint wait or a leased run", async () => {
    const repo = new MemoryRunRepository();
    seed(repo, { id: RUN_ID, requestId: REQUEST_ID, phase: "awaiting_cp2", approved: ["CP1"] });
    expect(await repo.claimDue(10, 30, NOW)).toHaveLength(0);

    const other = "55555555-5555-4555-8555-555555555555";
    seed(repo, { id: other, requestId: REQUEST_ID, phase: "queued" });
    const first = await repo.claimDue(10, 30, NOW);
    expect(first.map((row) => row.id)).toEqual([other]);
    expect(await repo.claimDue(10, 30, NOW)).toHaveLength(0);
    const later = new Date(NOW.getTime() + 31_000);
    expect(await repo.claimDue(10, 30, later)).toHaveLength(1);
  });
});
