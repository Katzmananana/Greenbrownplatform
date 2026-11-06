import type { Checkpoint, OrgConfig, RunPhase, RunStatus } from "@gb/shared";
import { RUN_PHASES } from "@gb/shared";
import type { CreditLedgerStore } from "@gb/credits";
import { defaultLabOrgConfig } from "@gb/credits";
import { configFromOrgRow, ledgerFromSums, type SpendSums } from "./credits.js";
import type { RunRepository } from "./repo.js";
import type { RunPatch, RunSnapshot } from "./types.js";

/** The subset of `pg` this process uses. Compiles without `@types/pg`. */
interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

interface PgClient extends PgQueryable {
  release(): void;
}

interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

const PHASES = new Set<string>(RUN_PHASES);

/**
 * Keep the phase list and the awaiting_cp* EXISTS clauses aligned with `isDue`.
 * Claim sets a lease but does not bump `version`: gateway approve CAS-es by
 * row lock and always increments version, so a poll must not invalidate it.
 * The transition save below is the compare-and-swap.
 */
export const CLAIM_SQL = `
WITH due AS (
  SELECT r.id
  FROM runs r
  WHERE r.status = 'active'
    AND (r.lease_until IS NULL OR r.lease_until < now())
    AND (
      r.phase IN ('queued', 'planning', 'coding', 'gates', 'fixing')
      OR (
        r.phase = 'awaiting_cp1' AND EXISTS (
          SELECT 1 FROM approvals a
          WHERE a.request_id = r.request_id AND a.checkpoint = 'CP1' AND a.decision = 'approved'
        )
      )
      OR (
        r.phase = 'awaiting_cp2' AND EXISTS (
          SELECT 1 FROM approvals a
          WHERE a.request_id = r.request_id AND a.checkpoint = 'CP2' AND a.decision = 'approved'
        )
      )
      OR (
        r.phase = 'awaiting_cp3' AND EXISTS (
          SELECT 1 FROM approvals a
          WHERE a.request_id = r.request_id AND a.checkpoint = 'CP3' AND a.decision = 'approved'
        )
      )
    )
  ORDER BY r.started_at ASC
  LIMIT $1
  FOR UPDATE OF r SKIP LOCKED
)
UPDATE runs AS u
SET lease_until = now() + ($2::int * interval '1 second'),
    heartbeat_at = now()
FROM due
WHERE u.id = due.id
RETURNING u.id, u.request_id, u.status, u.phase, u.phase_reason, u.iteration,
          u.version, u.started_at, u.deadline_at`;

export const SAVE_SQL = `
UPDATE runs
SET phase = $3,
    phase_reason = $4,
    iteration = $5,
    status = $6,
    deadline_at = $7,
    ended_at = CASE WHEN $6 = 'active' THEN ended_at ELSE COALESCE(ended_at, now()) END,
    heartbeat_at = now(),
    lease_until = NULL,
    version = version + 1
WHERE id = $1 AND version = $2 AND status = 'active'`;

export function rowToSnapshot(
  row: Record<string, unknown>,
  requestText: string | null,
  approved: readonly Checkpoint[],
): RunSnapshot | null {
  const phase = String(row.phase ?? "");
  if (!PHASES.has(phase)) return null;
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    requestText,
    status: String(row.status) as RunStatus,
    phase: phase as RunPhase,
    phaseReason: row.phase_reason == null ? null : String(row.phase_reason),
    iteration: Number(row.iteration ?? 0),
    version: Number(row.version ?? 0),
    startedAt: toIso(row.started_at) ?? new Date(0).toISOString(),
    deadlineAt: toIso(row.deadline_at),
    approved,
  };
}

export class PostgresRunRepository implements RunRepository {
  constructor(private readonly pool: PgPool) {}

  async claimDue(limit: number, leaseSeconds: number, _now: Date): Promise<RunSnapshot[]> {
    const client = await this.pool.connect();
    let rows: any[] = [];
    try {
      await client.query("BEGIN");
      const claimed = await client.query(CLAIM_SQL, [limit, leaseSeconds]);
      await client.query("COMMIT");
      rows = claimed.rows;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw describeSchemaError(err);
    } finally {
      client.release();
    }
    const requestIds = rows.map((row) => String(row.request_id));
    const approved = await loadApprovals(this.pool, requestIds);
    const texts = await loadRequestText(this.pool, requestIds);
    const snapshots: RunSnapshot[] = [];
    for (const row of rows) {
      const requestId = String(row.request_id);
      const snapshot = rowToSnapshot(
        row,
        texts.get(requestId) ?? null,
        approved.get(requestId) ?? [],
      );
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }

  async save(prev: RunSnapshot, patch: RunPatch): Promise<"ok" | "conflict"> {
    const { rows } = await this.pool.query(`${SAVE_SQL} RETURNING id`, [
      prev.id,
      prev.version,
      patch.phase,
      patch.phaseReason,
      patch.iteration,
      patch.status,
      patch.deadlineAt,
    ]);
    return rows.length > 0 ? "ok" : "conflict";
  }

  async release(id: string, version: number): Promise<void> {
    await this.pool.query(
      `UPDATE runs
       SET lease_until = NULL, heartbeat_at = now()
       WHERE id = $1 AND version = $2 AND status = 'active'`,
      [id, version],
    );
  }

  async loadConfig(): Promise<OrgConfig> {
    const { rows } = await this.pool.query(
      `SELECT id, org_id, max_fix_iterations, max_allowed_iterations, max_cost_usd,
              max_cost_usd_per_run, per_role_budget_usd, credit_alert_pct,
              max_wall_clock_seconds, coding_agent, allow_self_approval,
              require_prod_approval, protected_paths, required_checks, updated_at, updated_by
       FROM org_config
       ORDER BY updated_at DESC
       LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return defaultLabOrgConfig();
    return configFromOrgRow(row);
  }

  async loadLedger(orgId: string, runId: string): Promise<CreditLedgerStore> {
    const sums: SpendSums = {
      orgUsd: await scalar(
        this.pool,
        `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd FROM credit_ledger WHERE org_id::text = $1`,
        [orgId],
      ),
      runUsd: await scalar(
        this.pool,
        `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd FROM credit_ledger WHERE run_id::text = $1`,
        [runId],
      ),
      byRole: await roleSums(this.pool, runId),
    };
    return ledgerFromSums(orgId, runId, sums);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function createPostgresRepository(
  connectionString: string,
): Promise<PostgresRunRepository> {
  const pool = await createPool(connectionString);
  return new PostgresRunRepository(pool);
}

async function createPool(connectionString: string): Promise<PgPool> {
  const moduleName = "pg";
  const mod = (await import(moduleName)) as {
    default?: { Pool?: new (config: { connectionString: string; max?: number }) => PgPool };
    Pool?: new (config: { connectionString: string; max?: number }) => PgPool;
  };
  const Pool = mod.default?.Pool ?? mod.Pool;
  if (!Pool) throw new Error("pg module has no Pool export");
  return new Pool({ connectionString, max: 5 });
}

async function loadApprovals(
  client: PgQueryable,
  requestIds: string[],
): Promise<Map<string, Checkpoint[]>> {
  const map = new Map<string, Checkpoint[]>();
  if (requestIds.length === 0) return map;
  const { rows } = await client.query(
    `SELECT request_id, checkpoint
     FROM approvals
     WHERE decision = 'approved' AND request_id = ANY($1::uuid[])
     ORDER BY at ASC`,
    [requestIds],
  );
  for (const row of rows) {
    const requestId = String(row.request_id);
    const list = map.get(requestId) ?? [];
    const checkpoint = String(row.checkpoint);
    if (checkpoint === "CP1" || checkpoint === "CP2" || checkpoint === "CP3") {
      if (!list.includes(checkpoint)) list.push(checkpoint);
    }
    map.set(requestId, list);
  }
  return map;
}

async function loadRequestText(
  client: PgQueryable,
  requestIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (requestIds.length === 0) return map;
  try {
    const { rows } = await client.query(
      `SELECT id, text FROM requests WHERE id = ANY($1::uuid[])`,
      [requestIds],
    );
    for (const row of rows) map.set(String(row.id), String(row.text ?? ""));
  } catch (err) {
    if (pgCode(err) !== "42P01") throw err;
  }
  return map;
}

async function scalar(pool: PgQueryable, sql: string, params: unknown[]): Promise<number> {
  try {
    const { rows } = await pool.query(sql, params);
    const n = Number(rows[0]?.usd ?? 0);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    if (pgCode(err) === "22P02" || pgCode(err) === "42P01") return 0;
    throw err;
  }
}

async function roleSums(
  pool: PgQueryable,
  runId: string,
): Promise<{ role: string; usd: number }[]> {
  try {
    const { rows } = await pool.query(
      `SELECT role, COALESCE(SUM(cost_usd), 0)::float8 AS usd
       FROM credit_ledger
       WHERE run_id::text = $1
       GROUP BY role`,
      [runId],
    );
    return rows.map((row) => ({ role: String(row.role), usd: Number(row.usd) }));
  } catch (err) {
    if (pgCode(err) === "22P02" || pgCode(err) === "42P01") return [];
    throw err;
  }
}

function describeSchemaError(err: unknown): Error {
  const code = pgCode(err);
  if (code === "42703") {
    return new Error("runs.phase is missing — apply db/migrations/003_run_phase.sql");
  }
  if (code === "42P01") {
    return new Error("runs table is missing — apply db/migrations/001_init.sql");
  }
  return err instanceof Error ? err : new Error(String(err));
}

function pgCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
