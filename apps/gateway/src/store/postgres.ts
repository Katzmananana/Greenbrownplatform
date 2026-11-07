import { createHash } from "node:crypto";
import { defaultLabOrgConfig } from "@gb/credits";
import {
  decideRunSuccess,
  isRunPhase,
  type Checkpoint,
  type ExecutionMode,
  type RunPhase,
  type RunStatus,
} from "@gb/shared";
import type { ApprovalRecord, ApproveInput, CreateRunInput, RunRecord, RunStore } from "./types.js";
import { RunStoreError } from "./types.js";
import { assertCanApprove, stageFor, statusAfterApproval } from "./workflow.js";

/** The subset of `pg` we use, so this file compiles without `pg` types installed. */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface PgClientLike extends PgQueryable {
  release(): void;
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runSelect(flags: { phase: boolean; safety: boolean }): string {
  const phase = flags.phase ? "r.phase, r.phase_reason," : "";
  const safety = flags.safety ? "r.execution_mode, r.commit_sha," : "";
  return `
  SELECT r.id, r.request_id, r.status, ${phase} ${safety} r.iteration, r.version, r.started_at, r.ended_at,
         q.text AS request
  FROM runs r
  LEFT JOIN requests q ON q.id = r.request_id
  WHERE r.id = $1`;
}

const APPROVALS_SELECT = `
  SELECT checkpoint, decision, user_id, comment, at
  FROM approvals
  WHERE request_id = $1 AND decision = 'approved'
  ORDER BY at ASC`;

/**
 * Run store backed by `db/migrations/001_init.sql` (runs, approvals) and
 * `002_requests.sql` (requests — holds the free-text request).
 */
export class PostgresRunStore implements RunStore {
  readonly kind = "postgres" as const;
  private readonly pool: PgPoolLike;
  /** Null until looked up. False when migration 003 has not been applied. */
  private phaseColumn: boolean | null = null;
  /** False when migration 004 has not been applied. Missing mode is treated as simulation. */
  private safetyColumn: boolean | null = null;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  private async hasPhaseColumn(): Promise<boolean> {
    if (this.phaseColumn !== null) return this.phaseColumn;
    const { rows } = await this.pool.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'phase'`,
    );
    this.phaseColumn = rows.length > 0;
    return this.phaseColumn;
  }

  private async hasSafetyColumn(): Promise<boolean> {
    if (this.safetyColumn !== null) return this.safetyColumn;
    const { rows } = await this.pool.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'execution_mode'`,
    );
    this.safetyColumn = rows.length > 0;
    return this.safetyColumn;
  }

  private async selectRun(
    db: PgQueryable,
    runId: string,
    forUpdate: boolean,
  ): Promise<any | undefined> {
    const flags = {
      phase: await this.hasPhaseColumn(),
      safety: await this.hasSafetyColumn(),
    };
    const lock = forUpdate ? " FOR UPDATE OF r" : "";
    const { rows } = await db.query(`${runSelect(flags)}${lock}`, [runId]);
    return rows[0];
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const { rows } = await this.pool.query(
      `WITH req AS (
         INSERT INTO requests (text, source) VALUES ($1, 'mcp') RETURNING id
       )
       INSERT INTO runs (request_id)
       SELECT id FROM req
       RETURNING id, request_id, status, iteration, version, started_at, ended_at`,
      [input.request],
    );
    const row = rows[0];
    if (!row) throw new Error("insert into runs returned no row");
    return toRecord({ ...row, request: input.request }, []);
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    if (!UUID_RE.test(runId)) return null;
    const row = await this.selectRun(this.pool, runId, false);
    if (!row) return null;
    const approvals = await this.pool.query(APPROVALS_SELECT, [row.request_id]);
    return toRecord(row, approvals.rows);
  }

  async approve(input: ApproveInput): Promise<RunRecord> {
    if (!UUID_RE.test(input.runId)) {
      throw new RunStoreError("not_found", `run ${input.runId} not found`);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await this.selectRun(client, input.runId, true);
      if (!row) {
        throw new RunStoreError("not_found", `run ${input.runId} not found`);
      }
      const existing = await client.query(APPROVALS_SELECT, [row.request_id]);
      if (!input.userId.trim() || !input.authTime) {
        throw new RunStoreError(
          "human_auth_required",
          "approve requires a verified human user id and auth_time",
        );
      }
      assertCanApprove(
        {
          runId: input.runId,
          status: row.status as RunStatus,
          phase: phaseOf(row.phase),
          approved: existing.rows.map((a) => a.checkpoint as Checkpoint),
        },
        input.checkpoint,
      );
      const success = await loadSuccess(client, input.runId, row);
      const subjectHash = createHash("sha256")
        .update(`${input.runId}:${input.checkpoint}:${row.request ?? ""}`)
        .digest("hex");
      await client.query(
        `INSERT INTO approvals
           (request_id, checkpoint, subject_hash, decision, comment, user_id, client_id, ip, auth_time)
         VALUES ($1, $2, $3, 'approved', $4, $5, 'mcp', $6, $7)`,
        [
          row.request_id,
          input.checkpoint,
          subjectHash,
          input.comment ?? null,
          input.userId,
          input.ip ?? null,
          input.authTime,
        ],
      );
      const nextStatus = statusAfterApproval(row.status as RunStatus, input.checkpoint, success.ok);
      const phaseReason =
        input.checkpoint === "CP3" ? (success.ok ? "cp3_approved" : success.reason) : null;
      await client.query(
        `UPDATE runs
         SET status = $2,
             version = version + 1,
             heartbeat_at = now(),
             phase_reason = COALESCE($4, phase_reason),
             ended_at = CASE WHEN $3::boolean THEN $5::timestamptz ELSE ended_at END
         WHERE id = $1`,
        [input.runId, nextStatus, nextStatus !== "active", phaseReason, input.authTime],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const updated = await this.getRun(input.runId);
    if (!updated) throw new RunStoreError("not_found", `run ${input.runId} not found`);
    return updated;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const REQUIRED_GATES = defaultLabOrgConfig().requiredChecks;

async function loadSuccess(
  db: PgQueryable,
  runId: string,
  row: any,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const mode: ExecutionMode = row.execution_mode === "live" ? "live" : "simulation";
  const commitSha = row.commit_sha == null ? null : String(row.commit_sha);
  let artifactCommitSha: string | null = null;
  const verified: string[] = [];
  const present = await db.query(`SELECT to_regclass('public.run_evidence') AS name`);
  if (present.rows[0]?.name) {
    const { rows } = await db.query(
      `SELECT kind, gate_name, mode, passed, commit_sha FROM run_evidence WHERE run_id = $1`,
      [runId],
    );
    for (const evidence of rows) {
      if (String(evidence.commit_sha) !== commitSha) continue;
      if (evidence.kind === "artifact") artifactCommitSha = commitSha;
      if (
        evidence.kind === "gate" &&
        evidence.mode === "verified" &&
        evidence.passed === true &&
        evidence.gate_name
      ) {
        verified.push(String(evidence.gate_name));
      }
    }
  }
  return decideRunSuccess({
    executionMode: mode,
    commitSha,
    artifactCommitSha,
    verifiedPassedGates: verified,
    requiredGates: REQUIRED_GATES,
  });
}

function phaseOf(value: unknown): RunPhase {
  return isRunPhase(value) ? value : "queued";
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toRecord(row: any, approvalRows: any[]): RunRecord {
  const approvals: ApprovalRecord[] = approvalRows.map((a) => ({
    checkpoint: a.checkpoint as Checkpoint,
    decision: "approved",
    userId: String(a.user_id),
    comment: a.comment ?? null,
    at: toIso(a.at) ?? "",
  }));
  return {
    runId: String(row.id),
    requestId: String(row.request_id),
    request: row.request ?? null,
    status: row.status as RunStatus,
    phase: phaseOf(row.phase),
    phaseReason: row.phase_reason == null ? null : String(row.phase_reason),
    executionMode: row.execution_mode === "live" ? "live" : "simulation",
    commitSha: row.commit_sha == null ? null : String(row.commit_sha),
    stage: stageFor(approvals.map((a) => a.checkpoint)),
    iteration: Number(row.iteration),
    version: Number(row.version),
    startedAt: toIso(row.started_at) ?? "",
    endedAt: toIso(row.ended_at),
    approvals,
  };
}
