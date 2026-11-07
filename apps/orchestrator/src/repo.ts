import type { CursorCloudClient } from "@gb/cursor-cloud";
import type {
  AgentJobName,
  AgentJobPayload,
  Checkpoint,
  ExecutionMode,
  OrgConfig,
  RunPhase,
  RunStatus,
} from "@gb/shared";
import { agentJobId, phaseAcceptsCheckpoint } from "@gb/shared";
import type { CreditLedgerStore } from "@gb/credits";
import { InMemoryCreditLedger, defaultLabOrgConfig } from "@gb/credits";
import { isDue } from "./due.js";
import type { RunPatch, RunSnapshot } from "./types.js";

export interface RunRepository {
  claimDue(limit: number, leaseSeconds: number, now: Date): Promise<RunSnapshot[]>;
  /** Compare-and-swap on version. Refuses rows that are no longer active. */
  save(prev: RunSnapshot, patch: RunPatch): Promise<"ok" | "conflict">;
  /** Drop the lease when the tick did not write. No-op if version moved. */
  release(id: string, version: number): Promise<void>;
  loadConfig(): Promise<OrgConfig>;
  loadLedger(orgId: string, runId: string): Promise<CreditLedgerStore>;
  loadSuccess(
    runId: string,
    requiredGates: readonly string[],
  ): Promise<{ executionMode: ExecutionMode; evidenceReady: boolean }>;
  currentDispatch(run: RunSnapshot): Promise<DispatchView>;
  /**
   * Reserve the estimate, write the outbox row, and advance the phase in one
   * critical section. A second call with the same key does not charge again.
   */
  commitDispatch(prev: RunSnapshot, patch: RunPatch, spend: DispatchSpend): Promise<CommitResult>;
  markEnqueued(idempotencyKey: string): Promise<void>;
  /** First completion increments executions. A repeat is a no-op. */
  markDispatchCompleted(idempotencyKey: string): Promise<{ executed: boolean }>;
  /**
   * A `running` row with a stale heartbeat becomes needs_reconciliation and
   * the run becomes needs_human. A fresh heartbeat is left alone.
   */
  reconcileStaleRunning(
    idempotencyKey: string,
    run: RunSnapshot,
    staleSeconds: number,
  ): Promise<boolean>;
  /**
   * Read a Cursor handle, if one exists. Never creates an agent.
   * `absent` means there is no handle (or the migration is not applied).
   */
  syncCursorDispatch(
    idempotencyKey: string,
    client: CursorCloudClient | null,
    staleSeconds: number,
  ): Promise<"absent" | "active" | "completed" | "reconciled">;
  /** Ask Cursor to cancel a launched run. Does not claim the call was stopped. */
  cancelCursorRuns(runId: string, client: CursorCloudClient | null): Promise<void>;
  /**
   * Terminal halt. Dispatches that have not started are cancelled. A running
   * dispatch becomes needs_reconciliation with cause halted_while_running.
   * That does not stop an external call, and it does not overwrite a cause
   * already stored on a reconciled row.
   */
  haltRun(prev: RunSnapshot, patch: RunPatch): Promise<"ok" | "conflict">;
  close(): Promise<void>;
}

export interface DispatchView {
  idempotencyKey: string;
  state:
    | "absent"
    | "pending"
    | "enqueued"
    | "running"
    | "completed"
    | "cancelled"
    | "failed"
    | "needs_reconciliation";
  executions: number;
  payload: AgentJobPayload | null;
}

export type CommitResult =
  | { status: "pending" | "completed"; idempotencyKey: string }
  | { status: "budget"; reason: string }
  | { status: "conflict" };

export interface DispatchSpend {
  orgId: string;
  runId: string;
  requestId: string;
  role: "planner" | "coder" | "fixer";
  jobName: AgentJobName;
  iteration: number;
  costUsd: number;
  payload: AgentJobPayload;
}

interface MemoryRow {
  id: string;
  requestId: string;
  requestText: string | null;
  status: RunStatus;
  phase: RunPhase;
  phaseReason: string | null;
  iteration: number;
  version: number;
  startedAt: string;
  deadlineAt: string | null;
  approved: Checkpoint[];
  leaseUntil: string | null;
  executionMode: ExecutionMode;
  evidenceReady: boolean;
}

/**
 * In-process store used by tests and as the spec for the SQL claim predicate
 * (`isDue`). `recordGatewayApproval` mirrors gateway `approve`: a checkpoint
 * is accepted only in its waiting phase, and only CP3 at `awaiting_cp3`
 * sets status to succeeded.
 */
export class MemoryRunRepository implements RunRepository {
  config: OrgConfig = defaultLabOrgConfig();
  private readonly rows = new Map<string, MemoryRow>();
  private readonly ledgers = new Map<string, CreditLedgerStore>();
  private readonly outbox = new Map<string, OutboxRow>();
  private chain: Promise<unknown> = Promise.resolve();

  seed(partial: Partial<RunSnapshot> & Pick<RunSnapshot, "id" | "requestId">): RunSnapshot {
    const row: MemoryRow = {
      id: partial.id,
      requestId: partial.requestId,
      requestText: partial.requestText ?? null,
      status: partial.status ?? "active",
      phase: partial.phase ?? "queued",
      phaseReason: partial.phaseReason ?? null,
      iteration: partial.iteration ?? 0,
      version: partial.version ?? 1,
      startedAt: partial.startedAt ?? new Date(0).toISOString(),
      deadlineAt: partial.deadlineAt ?? null,
      approved: [...(partial.approved ?? [])],
      leaseUntil: null,
      executionMode: partial.executionMode ?? "simulation",
      evidenceReady: partial.evidenceReady ?? false,
    };
    this.rows.set(row.id, row);
    return this.view(row);
  }

  get(id: string): RunSnapshot | null {
    const row = this.rows.get(id);
    return row ? this.view(row) : null;
  }

  setLedger(runId: string, ledger: CreditLedgerStore): void {
    this.ledgers.set(runId, ledger);
  }

  /**
   * Mirrors gateway `assertCanApprove`: wrong phase is `not_ready` and does
   * not record the approval or change status. CP3 at `awaiting_cp3` succeeds.
   */
  recordGatewayApproval(id: string, checkpoint: Checkpoint): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`run ${id} not found`);
    if (row.status !== "active") {
      throw new Error(`run ${id} is ${row.status}; approvals require an active run`);
    }
    const order: readonly Checkpoint[] = ["CP1", "CP2", "CP3"];
    if (row.approved.includes(checkpoint)) {
      throw new Error(`${checkpoint} is already approved for run ${id}`);
    }
    const expected = order.find((cp) => !row.approved.includes(cp));
    if (expected !== checkpoint) {
      throw new Error(`cannot approve ${checkpoint}; next checkpoint is ${expected ?? "none"}`);
    }
    if (!phaseAcceptsCheckpoint(row.phase, checkpoint)) {
      throw new Error(
        `not_ready: cannot approve ${checkpoint}; orchestrator phase is ${row.phase}`,
      );
    }
    row.approved.push(checkpoint);
    row.version += 1;
    if (checkpoint === "CP3") {
      if (row.executionMode === "live" && row.evidenceReady) {
        row.status = "succeeded";
        row.phaseReason = "cp3_approved";
      } else {
        row.status = "needs_human";
        row.phaseReason =
          row.executionMode === "live" ? "evidence_missing" : "simulation_not_success";
      }
    }
  }

  async claimDue(limit: number, leaseSeconds: number, now: Date): Promise<RunSnapshot[]> {
    const due = [...this.rows.values()]
      .filter((row) => isDue(row, now))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
      .slice(0, limit);
    const until = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    for (const row of due) row.leaseUntil = until;
    return due.map((row) => this.view(row));
  }

  async save(prev: RunSnapshot, patch: RunPatch): Promise<"ok" | "conflict"> {
    const row = this.rows.get(prev.id);
    if (!row || row.version !== prev.version || row.status !== "active") return "conflict";
    row.status = patch.status;
    row.phase = patch.phase;
    row.phaseReason = patch.phaseReason;
    row.iteration = patch.iteration;
    row.deadlineAt = patch.deadlineAt;
    row.version += 1;
    row.leaseUntil = null;
    return "ok";
  }

  async release(id: string, version: number): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.version !== version || row.status !== "active") return;
    row.leaseUntil = null;
  }

  async loadConfig(): Promise<OrgConfig> {
    return this.config;
  }

  async loadLedger(_orgId: string, runId: string): Promise<CreditLedgerStore> {
    return this.ledgerFor(runId);
  }

  async loadSuccess(
    runId: string,
    requiredGates: readonly string[],
  ): Promise<{ executionMode: ExecutionMode; evidenceReady: boolean }> {
    const row = this.rows.get(runId);
    const executionMode = row?.executionMode ?? "simulation";
    const evidenceReady =
      executionMode === "live" && row?.evidenceReady === true && requiredGates.length > 0;
    return { executionMode, evidenceReady };
  }

  async currentDispatch(run: RunSnapshot): Promise<DispatchView> {
    const spec = agentSpec(run);
    const idempotencyKey = spec ? dispatchKey(run.id, spec.name, run.iteration) : "";
    const row = idempotencyKey ? this.outbox.get(idempotencyKey) : undefined;
    if (!row) return { idempotencyKey, state: "absent", executions: 0, payload: null };
    return {
      idempotencyKey,
      state: row.state,
      executions: row.executions,
      payload: row.payload,
    };
  }

  async commitDispatch(
    prev: RunSnapshot,
    patch: RunPatch,
    spend: DispatchSpend,
  ): Promise<CommitResult> {
    return this.exclusive(() => {
      const row = this.rows.get(prev.id);
      if (!row || row.version !== prev.version || row.status !== "active") {
        return { status: "conflict" };
      }
      const key = dispatchKey(prev.id, spend.jobName, spend.iteration);
      const existing = this.outbox.get(key);
      if (!(spend.costUsd > 0)) {
        this.applyHalt(row, {
          ...patch,
          status: "needs_human",
          phaseReason: "unbudgeted_estimate",
        });
        return { status: "budget", reason: "unbudgeted_estimate" };
      }
      if (!existing) {
        const ledger = this.ledgerFor(prev.id);
        const orgConfig = this.config;
        const orgSpend = ledger.sumOrg(spend.orgId) + spend.costUsd;
        const runSpend = ledger.sumRun(prev.id) + spend.costUsd;
        const roleSpend = ledger.sumRole(spend.orgId, prev.id, spend.role) + spend.costUsd;
        const roleCap = orgConfig.perRoleBudgetUsd[spend.role];
        if (
          orgSpend > orgConfig.maxCostUsd ||
          runSpend > orgConfig.maxCostUsdPerRun ||
          (roleCap != null && roleSpend > roleCap)
        ) {
          this.applyHalt(row, {
            ...patch,
            status: "needs_human",
            phaseReason: "credit_hard_stop",
          });
          return { status: "budget", reason: "credit_hard_stop" };
        }
        ledger.append({
          id: dispatchReason(spend),
          orgId: spend.orgId,
          requestId: spend.requestId,
          runId: prev.id,
          role: spend.role,
          provider: "none",
          model: "stub",
          inTokens: 0,
          outTokens: 0,
          costUsd: spend.costUsd,
          reason: dispatchReason(spend),
          createdAt: new Date(0).toISOString(),
        });
        this.outbox.set(key, {
          state: "pending",
          executions: 0,
          payload: spend.payload,
          heartbeatAt: null,
          reconciliation: null,
        });
      }
      this.applyPatch(row, patch);
      const state = this.outbox.get(key)?.state ?? "pending";
      return { status: state === "completed" ? "completed" : "pending", idempotencyKey: key };
    });
  }

  async markEnqueued(idempotencyKey: string): Promise<void> {
    const row = this.outbox.get(idempotencyKey);
    if (row && row.state === "pending") row.state = "enqueued";
  }

  async syncCursorDispatch(): Promise<"absent" | "active" | "completed" | "reconciled"> {
    return "absent";
  }

  async cancelCursorRuns(): Promise<void> {}

  async reconcileStaleRunning(
    idempotencyKey: string,
    run: RunSnapshot,
    staleSeconds: number,
  ): Promise<boolean> {
    const row = this.outbox.get(idempotencyKey);
    if (!row || row.state !== "running" || row.reconciliation) return false;
    const beat = row.heartbeatAt ? Date.parse(row.heartbeatAt) : 0;
    if (Date.now() - beat < staleSeconds * 1000) return false;
    row.state = "needs_reconciliation";
    row.reconciliation = "crash_after_running";
    const stored = this.rows.get(run.id);
    if (stored && stored.status === "active") {
      this.applyHalt(stored, {
        status: "needs_human",
        phase: stored.phase,
        phaseReason: "needs_reconciliation",
        iteration: stored.iteration,
        deadlineAt: stored.deadlineAt,
      });
    }
    return true;
  }

  async markDispatchCompleted(idempotencyKey: string): Promise<{ executed: boolean }> {
    const row = this.outbox.get(idempotencyKey);
    if (
      !row ||
      row.state === "completed" ||
      row.state === "cancelled" ||
      row.state === "needs_reconciliation" ||
      row.reconciliation
    ) {
      return { executed: false };
    }
    row.state = "completed";
    row.executions += 1;
    return { executed: true };
  }

  async haltRun(prev: RunSnapshot, patch: RunPatch): Promise<"ok" | "conflict"> {
    const row = this.rows.get(prev.id);
    if (!row || row.version !== prev.version || row.status !== "active") return "conflict";
    this.applyHalt(row, patch);
    return "ok";
  }

  private ledgerFor(runId: string): InMemoryCreditLedger {
    const existing = this.ledgers.get(runId);
    if (existing instanceof InMemoryCreditLedger) return existing;
    const created = new InMemoryCreditLedger();
    if (existing) {
      for (const entry of existing.list()) created.append(entry);
    }
    this.ledgers.set(runId, created);
    return created;
  }

  async close(): Promise<void> {}

  private view(row: MemoryRow): RunSnapshot {
    return {
      id: row.id,
      requestId: row.requestId,
      requestText: row.requestText,
      status: row.status,
      phase: row.phase,
      phaseReason: row.phaseReason,
      iteration: row.iteration,
      version: row.version,
      startedAt: row.startedAt,
      deadlineAt: row.deadlineAt,
      approved: [...row.approved],
      executionMode: row.executionMode,
      evidenceReady: row.evidenceReady,
    };
  }

  private exclusive<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(() => fn());
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private applyPatch(row: MemoryRow, patch: RunPatch): void {
    row.status = patch.status;
    row.phase = patch.phase;
    row.phaseReason = patch.phaseReason;
    row.iteration = patch.iteration;
    row.deadlineAt = patch.deadlineAt;
    row.version += 1;
    row.leaseUntil = null;
  }

  private applyHalt(row: MemoryRow, patch: RunPatch): void {
    this.applyPatch(row, patch);
    for (const job of this.outbox.values()) {
      if (job.payload.runId !== row.id) continue;
      if (job.state === "pending" || job.state === "enqueued") job.state = "cancelled";
      else if (job.state === "running") {
        job.state = "needs_reconciliation";
        if (!job.reconciliation) job.reconciliation = "halted_while_running";
      }
    }
  }
}

interface OutboxRow {
  state:
    | "pending"
    | "enqueued"
    | "running"
    | "completed"
    | "cancelled"
    | "failed"
    | "needs_reconciliation";
  heartbeatAt: string | null;
  reconciliation: string | null;
  executions: number;
  payload: AgentJobPayload;
}

function dispatchKey(runId: string, name: AgentJobName, iteration: number): string {
  return agentJobId({ name, runId, iteration });
}

function agentSpec(run: RunSnapshot): { name: AgentJobName } | null {
  if (run.phase === "planning") return { name: "plan" };
  if (run.phase === "coding") return { name: "code" };
  if (run.phase === "fixing") return { name: "fix" };
  return null;
}

export function dispatchReason(input: DispatchSpend): string {
  return `orchestrator_dispatch:${input.jobName}:${input.iteration}`;
}
