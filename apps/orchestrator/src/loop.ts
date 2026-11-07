import type { CreditAlert, OrgConfig } from "@gb/shared";
import { CreditGuard, CreditHardStopError } from "@gb/credits";
import type { JobDispatcher } from "./dispatcher.js";
import { evaluateStubGates } from "./gates.js";
import { agentSpecForPhase, stepRun } from "./machine.js";
import type { RunRepository } from "./repo.js";
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
      const outcome = await advance(deps, config, run);
      if (outcome.patch) {
        const result = await deps.repo.save(run, outcome.patch);
        if (result === "conflict") {
          stats.conflicts += 1;
          console.log(
            JSON.stringify({
              msg: "orchestrator skipped conflicting write",
              runId: run.id,
              version: run.version,
            }),
          );
          continue;
        }
        saved = true;
        stats.saved += 1;
        if (outcome.enqueue && deps.estimateUsd > 0) {
          await deps.repo.recordDispatch({
            orgId: config.orgId,
            runId: run.id,
            requestId: run.requestId,
            role: outcome.enqueue.role,
            jobName: outcome.enqueue.name,
            iteration: outcome.enqueue.iteration,
            costUsd: deps.estimateUsd,
          });
        }
      }
      if (outcome.enqueue) {
        await deps.jobs.enqueue(outcome.enqueue);
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

async function advance(deps: TickDeps, config: OrgConfig, run: RunSnapshot) {
  const spec = agentSpecForPhase(run.phase);
  const jobState = spec
    ? await deps.jobs.state({ name: spec.name, runId: run.id, iteration: run.iteration })
    : null;
  const gates =
    run.phase === "gates"
      ? (deps.gateRunner ?? ((snapshot, org) => evaluateStubGates(org, deps.failGates ?? [])))(
          run,
          config,
        )
      : [];
  const ledger = await deps.repo.loadLedger(config.orgId, run.id);
  const guard = new CreditGuard(config, ledger, deps.onAlert ?? logAlert);
  const estimate = deps.estimateUsd > 0 ? deps.estimateUsd : 0;
  return stepRun(run, {
    now: deps.now,
    config,
    jobState,
    gates,
    assertSpend: (role: SpendRole) => {
      try {
        guard.assertCanSpend({
          orgId: config.orgId,
          runId: run.id,
          requestId: run.requestId,
          role,
          estimatedCostUsd: estimate,
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
}

function logAlert(alert: CreditAlert): void {
  console.log(JSON.stringify({ msg: "credit_alert", alert }));
}
