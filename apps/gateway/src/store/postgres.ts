import { createHash } from "node:crypto";
import type { Checkpoint, RunStatus } from "@gb/shared";
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

const RUN_SELECT = `
  SELECT r.id, r.request_id, r.status, r.iteration, r.version, r.started_at, r.ended_at,
         q.text AS request
  FROM runs r
  LEFT JOIN requests q ON q.id = r.request_id
  WHERE r.id = $1`;

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

  constructor(pool: PgPoolLike) {
    this.pool = pool;
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
    const { rows } = await this.pool.query(RUN_SELECT, [runId]);
    const row = rows[0];
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
      const { rows } = await client.query(`${RUN_SELECT} FOR UPDATE OF r`, [input.runId]);
      const row = rows[0];
      if (!row) {
        throw new RunStoreError("not_found", `run ${input.runId} not found`);
      }
      const existing = await client.query(APPROVALS_SELECT, [row.request_id]);
      assertCanApprove(
        {
          runId: input.runId,
          status: row.status as RunStatus,
          approved: existing.rows.map((a) => a.checkpoint as Checkpoint),
        },
        input.checkpoint,
      );
      const subjectHash = createHash("sha256")
        .update(`${input.runId}:${input.checkpoint}:${row.request ?? ""}`)
        .digest("hex");
      await client.query(
        `INSERT INTO approvals
           (request_id, checkpoint, subject_hash, decision, comment, user_id, client_id, ip, auth_time)
         VALUES ($1, $2, $3, 'approved', $4, $5, 'mcp', $6, now())`,
        [
          row.request_id,
          input.checkpoint,
          subjectHash,
          input.comment ?? null,
          input.userId,
          input.ip ?? null,
        ],
      );
      const nextStatus = statusAfterApproval(row.status as RunStatus, input.checkpoint);
      await client.query(
        `UPDATE runs
         SET status = $2,
             version = version + 1,
             heartbeat_at = now(),
             ended_at = CASE WHEN $3::boolean THEN now() ELSE ended_at END
         WHERE id = $1`,
        [input.runId, nextStatus, nextStatus !== "active"],
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
    stage: stageFor(approvals.map((a) => a.checkpoint)),
    iteration: Number(row.iteration),
    version: Number(row.version),
    startedAt: toIso(row.started_at) ?? "",
    endedAt: toIso(row.ended_at),
    approvals,
  };
}
