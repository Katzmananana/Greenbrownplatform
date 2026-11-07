import type { AgentJobName, Checkpoint, OrgConfig, RunPhase, RunStatus } from "@gb/shared";
import { phaseAcceptsCheckpoint } from "@gb/shared";
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
  /**
   * Record the estimated cost of a new agent dispatch once. Re-enqueue of the
   * same role+iteration must not call this again.
   */
  recordDispatch(input: DispatchSpend): Promise<void>;
  close(): Promise<void>;
}

export interface DispatchSpend {
  orgId: string;
  runId: string;
  requestId: string;
  role: "planner" | "coder" | "fixer";
  jobName: AgentJobName;
  iteration: number;
  costUsd: number;
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
    if (checkpoint === "CP3") row.status = "succeeded";
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

  async recordDispatch(input: DispatchSpend): Promise<void> {
    if (!(input.costUsd > 0)) return;
    const ledger = this.ledgerFor(input.runId);
    const reason = dispatchReason(input);
    if (ledger.list().some((entry) => entry.runId === input.runId && entry.reason === reason)) {
      return;
    }
    ledger.append({
      id: reason,
      orgId: input.orgId,
      requestId: input.requestId,
      runId: input.runId,
      role: input.role,
      provider: "none",
      model: "stub",
      inTokens: 0,
      outTokens: 0,
      costUsd: input.costUsd,
      reason,
      createdAt: new Date(0).toISOString(),
    });
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
    };
  }
}

export function dispatchReason(input: DispatchSpend): string {
  return `orchestrator_dispatch:${input.jobName}:${input.iteration}`;
}
