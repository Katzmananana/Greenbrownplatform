import type { AgentJobName, AgentJobPayload, RunPhase } from "@gb/shared";
import { decideFixLoop } from "@gb/gates";
import type { RunPatch, RunSnapshot, SpendRole, StepContext } from "./types.js";

export interface StepOutcome {
  /** Null means hold: do not write, do not enqueue. */
  patch: RunPatch | null;
  enqueue: AgentJobPayload | null;
}

const HOLD: StepOutcome = { patch: null, enqueue: null };

type AgentSpec = {
  name: AgentJobName;
  role: SpendRole;
  phase: Extract<RunPhase, "planning" | "coding" | "fixing">;
};

const PLAN: AgentSpec = { name: "plan", role: "planner", phase: "planning" };
const CODE: AgentSpec = { name: "code", role: "coder", phase: "coding" };
const FIX: AgentSpec = { name: "fix", role: "fixer", phase: "fixing" };

export function agentSpecForPhase(phase: RunPhase): AgentSpec | null {
  if (phase === "planning") return PLAN;
  if (phase === "coding") return CODE;
  if (phase === "fixing") return FIX;
  return null;
}

/**
 * One transition of an active run.
 *
 * Gateway owns approvals. CP3 may set `succeeded` only while phase is
 * `awaiting_cp3`, which this machine reaches after planning, coding, and a
 * green gate pass. Approvals already stored do not skip that work and do not
 * close the run early. Callers CAS the save on `version` and `status = 'active'`.
 */
export function stepRun(run: RunSnapshot, ctx: StepContext): StepOutcome {
  if (run.status !== "active") return HOLD;

  const deadlineAt = ensureDeadline(run, ctx);
  if (pastDeadline(ctx, deadlineAt)) {
    return halt(run, "needs_human", "wall_clock", deadlineAt);
  }

  switch (run.phase) {
    case "queued":
      return startAgent(run, ctx, PLAN, run.iteration, deadlineAt, null);
    case "planning":
    case "coding":
    case "fixing":
      return onAgentPhase(run, ctx, deadlineAt);
    case "awaiting_cp1":
      if (!run.approved.includes("CP1")) return HOLD;
      return startAgent(run, ctx, CODE, run.iteration, deadlineAt, null);
    case "gates":
      return onGates(run, ctx, deadlineAt);
    case "awaiting_cp2":
      if (!run.approved.includes("CP2")) return HOLD;
      return move(run, "awaiting_cp3", deadlineAt);
    case "awaiting_cp3":
      if (!run.approved.includes("CP3")) return HOLD;
      if (run.executionMode !== "live" || !run.evidenceReady) {
        return halt(
          run,
          "needs_human",
          run.executionMode !== "live" ? "simulation_not_success" : "evidence_missing",
          deadlineAt,
        );
      }
      return succeed(run, deadlineAt);
    default:
      return HOLD;
  }
}

function onAgentPhase(run: RunSnapshot, ctx: StepContext, deadlineAt: string): StepOutcome {
  const state = ctx.jobState ?? "missing";
  if (state === "waiting" || state === "active") return HOLD;
  if (state === "completed") return onAgentCompleted(run, ctx, deadlineAt);
  if (state === "failed") return onAgentFailed(run, ctx, deadlineAt);
  const spec = agentSpecForPhase(run.phase);
  if (!spec) return HOLD;
  // Same dispatch as the one already charged. Do not apply the estimate again.
  return startAgent(run, ctx, spec, run.iteration, deadlineAt, null, true);
}

function onAgentCompleted(run: RunSnapshot, ctx: StepContext, deadlineAt: string): StepOutcome {
  if (run.phase === "planning") {
    if (run.approved.includes("CP1")) {
      return startAgent(run, ctx, CODE, run.iteration, deadlineAt, null);
    }
    return move(run, "awaiting_cp1", deadlineAt);
  }
  if (run.phase === "coding" || run.phase === "fixing") {
    return move(run, "gates", deadlineAt);
  }
  return HOLD;
}

function onAgentFailed(run: RunSnapshot, ctx: StepContext, deadlineAt: string): StepOutcome {
  const decision = decideFixLoop(ctx.config, run.iteration);
  if (decision.action === "escalate") {
    return halt(run, "escalated", decision.reason ?? "fix_loop_cap", deadlineAt);
  }
  const spec = run.phase === "planning" ? PLAN : FIX;
  return startAgent(run, ctx, spec, decision.nextIteration, deadlineAt, "worker_job_failed");
}

function onGates(run: RunSnapshot, ctx: StepContext, deadlineAt: string): StepOutcome {
  const failed = ctx.gates.filter((gate) => !gate.passed);
  if (failed.length === 0) return afterGreenGates(run, deadlineAt);
  const decision = decideFixLoop(ctx.config, run.iteration);
  if (decision.action === "escalate") {
    return halt(run, "escalated", decision.reason ?? "fix_loop_cap", deadlineAt);
  }
  return startAgent(run, ctx, FIX, decision.nextIteration, deadlineAt, "gate_failed");
}

function afterGreenGates(run: RunSnapshot, deadlineAt: string): StepOutcome {
  if (!run.approved.includes("CP2")) return move(run, "awaiting_cp2", deadlineAt);
  return move(run, "awaiting_cp3", deadlineAt);
}

function startAgent(
  run: RunSnapshot,
  ctx: StepContext,
  spec: AgentSpec,
  iteration: number,
  deadlineAt: string,
  phaseReason: string | null,
  keepPhase = false,
): StepOutcome {
  if (!keepPhase) {
    const spend = ctx.assertSpend(spec.role);
    if (!spend.ok) return halt(run, "needs_human", spend.message, deadlineAt);
  }
  const enqueue: AgentJobPayload = {
    v: 1,
    name: spec.name,
    role: spec.role,
    runId: run.id,
    requestId: run.requestId,
    iteration,
    requestText: run.requestText,
  };
  if (
    keepPhase &&
    iteration === run.iteration &&
    phaseReason === null &&
    run.phase === spec.phase
  ) {
    return { patch: null, enqueue };
  }
  return {
    patch: {
      status: "active",
      phase: spec.phase,
      phaseReason,
      iteration,
      deadlineAt,
    },
    enqueue,
  };
}

function move(run: RunSnapshot, phase: RunPhase, deadlineAt: string): StepOutcome {
  return {
    patch: {
      status: "active",
      phase,
      phaseReason: null,
      iteration: run.iteration,
      deadlineAt,
    },
    enqueue: null,
  };
}

function succeed(run: RunSnapshot, deadlineAt: string): StepOutcome {
  return {
    patch: {
      status: "succeeded",
      phase: run.phase,
      phaseReason: "cp3_approved",
      iteration: run.iteration,
      deadlineAt,
    },
    enqueue: null,
  };
}

function halt(
  run: RunSnapshot,
  status: "needs_human" | "escalated",
  phaseReason: string,
  deadlineAt: string,
): StepOutcome {
  return {
    patch: {
      status,
      phase: run.phase,
      phaseReason,
      iteration: run.iteration,
      deadlineAt,
    },
    enqueue: null,
  };
}

function ensureDeadline(run: RunSnapshot, ctx: StepContext): string {
  if (run.deadlineAt) return run.deadlineAt;
  const start = Date.parse(run.startedAt);
  const base = Number.isFinite(start) ? start : ctx.now.getTime();
  const seconds = ctx.config.maxWallClockSeconds > 0 ? ctx.config.maxWallClockSeconds : 0;
  return new Date(base + seconds * 1000).toISOString();
}

function pastDeadline(ctx: StepContext, deadlineAt: string): boolean {
  if (ctx.config.maxWallClockSeconds <= 0) return false;
  const at = Date.parse(deadlineAt);
  if (!Number.isFinite(at)) return false;
  return ctx.now.getTime() > at;
}
