import type { CreditAlert, OrgConfig } from "@gb/shared";
import { CreditGuard, CreditHardStopError } from "@gb/credits";
import type { JobDispatcher } from "./dispatcher.js";
import { evaluateStubGates } from "./gates.js";
import { runIsExpired, stepRun } from "./machine.js";
import type { DispatchSpend, RunRepository } from "./repo.js";
import type { RunSnapshot, SpendRole } from "./types.js";

export interface TickStats {
  claimed: number;
  saved: number;
  conflicts: number;
  enqueued: number;
  errors: number;
}

export interface TickDeps {
  repo: RunRepository;
  jobs: JobDispatcher;
  now: Date;
  leaseSeconds: number;
  batchSize: number;
  /** Estimated USD charged before each stub agent dispatch. 0 still hard-stops an already-over ledger. */
  estimateUsd: number;
  /** Running rows older than this are needs_reconciliation, not left implicit. */
  staleSeconds?: number;
  failGates?: readonly string[];
  gateRunner?: (run: RunSnapshot, config: OrgConfig) => { name: string; passed: boolean }[];
  onAlert?: (alert: CreditAlert) => void;
}

/**
 * One poll: claim due runs, advance each a single phase, enqueue at most one
 * job after the CAS save commits. A version conflict means gateway (or
 * another orchestrator) wrote first — the job is not enqueued.
 */
export async function runTick(deps: TickDeps): Promise<TickStats> {
  const stats: TickStats = { claimed: 0, saved: 0, conflicts: 0, enqueued: 0, errors: 0 };
  const config = await deps.repo.loadConfig();
  const claimed = await deps.repo.claimDue(deps.batchSize, deps.leaseSeconds, deps.now);
  stats.claimed = claimed.length;

  for (const run of claimed) {
    let saved = false;
    try {
      const prepared = await prepareRun(deps, config, run);
      if (prepared.reconciled) {
        saved = true;
        stats.saved += 1;
        console.log(
          JSON.stringify({
            msg: "orchestrator needs_reconciliation",
            runId: run.id,
            reason: "needs_reconciliation",
          }),
        );
        continue;
      }
      const outcome = prepared.outcome;
      if (
        outcome.patch &&
        (outcome.patch.status === "needs_human" || outcome.patch.status === "escalated")
      ) {
        const halted = await deps.repo.haltRun(prepared.run, outcome.patch);
        if (halted === "conflict") stats.conflicts += 1;
        else {
          saved = true;
          stats.saved += 1;
        }
      } else if (outcome.enqueue && outcome.patch) {
        const spend: DispatchSpend = {
          orgId: config.orgId,
          runId: run.id,
          requestId: run.requestId,
          role: outcome.enqueue.role,
          jobName: outcome.enqueue.name,
          iteration: outcome.enqueue.iteration,
          costUsd: deps.estimateUsd,
          payload: outcome.enqueue,
        };
        const committed = await deps.repo.commitDispatch(prepared.run, outcome.patch, spend);
        if (committed.status === "conflict") stats.conflicts += 1;
        else if (committed.status === "budget") {
          saved = true;
          stats.saved += 1;
        } else if (committed.status === "pending") {
          await deps.jobs.enqueue(outcome.enqueue);
          await deps.repo.markEnqueued(committed.idempotencyKey);
          saved = true;
          stats.saved += 1;
          stats.enqueued += 1;
        } else {
          saved = true;
          stats.saved += 1;
        }
      } else if (outcome.patch) {
        const result = await deps.repo.save(prepared.run, outcome.patch);
        if (result === "conflict") stats.conflicts += 1;
        else {
          saved = true;
          stats.saved += 1;
        }
      } else if (prepared.recovered) {
        stats.enqueued += 1;
      }
      if (outcome.patch || outcome.enqueue) {
        console.log(
          JSON.stringify({
            msg: "orchestrator step",
            runId: run.id,
            from: run.phase,
            to: outcome.patch?.phase ?? run.phase,
            status: outcome.patch?.status ?? run.status,
            iteration: outcome.patch?.iteration ?? run.iteration,
            job: outcome.enqueue?.name ?? null,
            reason: outcome.patch?.phaseReason ?? null,
          }),
        );
      }
    } catch (err) {
      stats.errors += 1;
      console.error(
        JSON.stringify({
          msg: "orchestrator run failed",
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      if (!saved) {
        await deps.repo.release(run.id, run.version).catch(() => undefined);
      }
    }
  }
  return stats;
}

async function prepareRun(deps: TickDeps, config: OrgConfig, run: RunSnapshot) {
  const expired =
    run.status !== "active" || runIsExpired(run, deps.now, config.maxWallClockSeconds);
  const current = await deps.repo.currentDispatch(run);
  let jobState: "missing" | "waiting" | "active" | "completed" | "failed" | null = null;
  let recovered = false;
  if (current.state === "running") {
    const reconciled = await deps.repo.reconcileStaleRunning(
      current.idempotencyKey,
      run,
      deps.staleSeconds ?? 30,
    );
    if (reconciled) {
      return {
        run,
        outcome: { patch: null, enqueue: null },
        recovered: false,
        reconciled: true,
      };
    }
    jobState = "active";
  } else if (current.state === "needs_reconciliation") {
    const halted = await deps.repo.haltRun(run, {
      status: "needs_human",
      phase: run.phase,
      phaseReason: "needs_reconciliation",
      iteration: run.iteration,
      deadlineAt: run.deadlineAt,
    });
    if (halted === "ok") {
      return {
        run,
        outcome: { patch: null, enqueue: null },
        recovered: false,
        reconciled: true,
      };
    }
    jobState = "failed";
  } else if (current.state === "completed") jobState = "completed";
  else if (current.state === "cancelled" || current.state === "failed") jobState = "failed";
  else if (
    !expired &&
    current.payload &&
    (current.state === "pending" || current.state === "enqueued")
  ) {
    const redis = await deps.jobs.state(current.payload);
    if (redis === "completed") {
      await deps.repo.markDispatchCompleted(current.idempotencyKey);
      jobState = "completed";
    } else if (redis === "failed") jobState = "failed";
    else if (redis === "missing") {
      await deps.jobs.enqueue(current.payload);
      await deps.repo.markEnqueued(current.idempotencyKey);
      recovered = true;
      jobState = "waiting";
    } else {
      jobState = redis === "active" ? "active" : "waiting";
    }
  }
  const success = await deps.repo.loadSuccess(run.id, config.requiredChecks);
  const prepared: RunSnapshot = {
    ...run,
    executionMode: success.executionMode,
    evidenceReady: success.evidenceReady,
  };
  const gates =
    prepared.phase === "gates"
      ? (deps.gateRunner ?? ((snapshot, org) => evaluateStubGates(org, deps.failGates ?? [])))(
          prepared,
          config,
        )
      : [];
  const ledger = await deps.repo.loadLedger(config.orgId, prepared.id);
  const guard = new CreditGuard(config, ledger, deps.onAlert ?? logAlert);
  const outcome = stepRun(prepared, {
    now: deps.now,
    config,
    jobState,
    gates,
    assertSpend: (role: SpendRole) => {
      if (!(deps.estimateUsd > 0)) {
        return { ok: false, message: "unbudgeted_estimate" };
      }
      try {
        guard.assertCanSpend({
          orgId: config.orgId,
          runId: prepared.id,
          requestId: prepared.requestId,
          role,
          estimatedCostUsd: deps.estimateUsd,
          provider: "none",
          model: "stub",
        });
        return { ok: true };
      } catch (err) {
        if (err instanceof CreditHardStopError) return { ok: false, message: err.message };
        throw err;
      }
    },
  });
  return { run: prepared, outcome, recovered, reconciled: false };
}

function logAlert(alert: CreditAlert): void {
  console.log(JSON.stringify({ msg: "credit_alert", alert }));
}
