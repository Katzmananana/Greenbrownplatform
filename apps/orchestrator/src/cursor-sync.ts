import {
  CursorCloudError,
  classifyRunStatus,
  readProviderGit,
  type CursorCloudClient,
  type CursorRun,
} from "@gb/cursor-cloud";

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export type CursorSync = "absent" | "active" | "completed" | "reconciled";

/**
 * Status retrieval for a dispatch that already has a Cursor handle.
 * This never calls create. A missing client, a failed read, or an
 * unrecognized status becomes needs_reconciliation and is not relaunched.
 */
export async function syncCursorDispatch(
  db: Queryable,
  idempotencyKey: string,
  client: CursorCloudClient | null,
  staleSeconds: number,
): Promise<CursorSync> {
  let row: HandleRow | null;
  try {
    row = await loadHandle(db, idempotencyKey, staleSeconds);
  } catch (err) {
    if (pgCode(err) === "42P01" || pgCode(err) === "42703") return "absent";
    throw err;
  }
  if (!row || row.outboxState !== "running") return "absent";
  if (row.launch === "refused" || row.launch === "ambiguous") {
    await settle(db, idempotencyKey, row.runId, row.reconciliation ?? "cursor_launch_ambiguous");
    return "reconciled";
  }
  if (row.launch === "intent") {
    await settle(db, idempotencyKey, row.runId, "cursor_launch_unconfirmed");
    return "reconciled";
  }
  if (!row.agentId || !row.providerRunId) {
    await settle(db, idempotencyKey, row.runId, "cursor_status_unavailable");
    return "reconciled";
  }
  if (!client) {
    if (row.heartbeatStale) {
      await settle(db, idempotencyKey, row.runId, "cursor_status_unavailable");
      return "reconciled";
    }
    return "active";
  }
  try {
    const run = await client.getRun(row.agentId, row.providerRunId);
    return applyObservedRun(db, idempotencyKey, row.runId, run);
  } catch (err) {
    if (err instanceof CursorCloudError && err.kind === "unavailable" && !row.heartbeatStale) {
      return "active";
    }
    const reason =
      err instanceof CursorCloudError ? `cursor_status_${err.kind}` : "cursor_status_ambiguous";
    await settle(db, idempotencyKey, row.runId, reason);
    return "reconciled";
  }
}

/**
 * Documented cancel is `POST /v1/agents/{id}/runs/{runId}/cancel`.
 * `cancel_confirmed` is set only when a later Get A Run says CANCELLED.
 * A transport failure or a cancel POST alone does not mean the remote call stopped.
 */
export async function cancelCursorRuns(
  db: Queryable,
  runId: string,
  client: CursorCloudClient | null,
): Promise<void> {
  let rows: HandleRow[];
  try {
    rows = await loadLaunched(db, runId);
  } catch (err) {
    if (pgCode(err) === "42P01" || pgCode(err) === "42703") return;
    throw err;
  }
  if (!client) {
    await db.query(
      `UPDATE cursor_dispatch
       SET reconciliation = COALESCE(reconciliation, 'cursor_cancel_unavailable'), updated_at = now()
       WHERE run_id = $1::uuid AND launch = 'launched' AND cancel_confirmed = false`,
      [runId],
    );
    return;
  }
  for (const row of rows) {
    if (!row.agentId || !row.providerRunId) continue;
    try {
      await client.cancelRun(row.agentId, row.providerRunId);
      const observed = await client.getRun(row.agentId, row.providerRunId);
      await recordCancel(db, row.idempotencyKey, observed);
    } catch (err) {
      if (
        err instanceof CursorCloudError &&
        err.kind === "conflict" &&
        err.code === "run_not_cancellable"
      ) {
        try {
          const observed = await client.getRun(row.agentId, row.providerRunId);
          await recordCancel(db, row.idempotencyKey, observed);
          continue;
        } catch {
          await markCancelUnconfirmed(db, row.idempotencyKey);
          continue;
        }
      }
      await markCancelUnconfirmed(db, row.idempotencyKey);
    }
  }
}

async function applyObservedRun(
  db: Queryable,
  idempotencyKey: string,
  runId: string,
  run: CursorRun,
): Promise<CursorSync> {
  const git = readProviderGit(run);
  await db.query(
    `UPDATE cursor_dispatch
     SET provider_status = $2,
         repo_url = COALESCE($3, repo_url),
         branch = COALESCE($4, branch),
         pr_url = COALESCE($5, pr_url),
         result_text = COALESCE($6, result_text),
         updated_at = now()
     WHERE idempotency_key = $1`,
    [
      idempotencyKey,
      run.status,
      git?.repoUrl ?? null,
      git?.branch ?? null,
      git?.prUrl ?? null,
      run.result ?? null,
    ],
  );
  const kind = classifyRunStatus(run.status);
  if (kind === "active") {
    await db.query(
      `UPDATE dispatch_outbox SET heartbeat_at = now() WHERE idempotency_key = $1 AND state = 'running'`,
      [idempotencyKey],
    );
    return "active";
  }
  if (kind === "unrecognized") {
    await settle(db, idempotencyKey, runId, "cursor_status_unrecognized");
    return "reconciled";
  }
  if (kind === "finished" && git) {
    const completed = await db.query(
      `UPDATE dispatch_outbox
       SET state = 'completed', completed_at = now()
       WHERE idempotency_key = $1 AND state = 'running'
       RETURNING idempotency_key`,
      [idempotencyKey],
    );
    return completed.rows.length > 0 ? "completed" : "active";
  }
  const reason = kind === "finished" ? "cursor_artifact_missing" : `cursor_run_${run.status}`;
  await settle(db, idempotencyKey, runId, reason);
  return "reconciled";
}

async function recordCancel(db: Queryable, idempotencyKey: string, run: CursorRun): Promise<void> {
  const confirmed = run.status === "CANCELLED";
  await db.query(
    `UPDATE cursor_dispatch
     SET provider_status = $2,
         cancel_confirmed = $3,
         reconciliation = CASE WHEN $3 THEN reconciliation ELSE COALESCE(reconciliation, 'cursor_cancel_unconfirmed') END,
         updated_at = now()
     WHERE idempotency_key = $1`,
    [idempotencyKey, run.status, confirmed],
  );
}

async function markCancelUnconfirmed(db: Queryable, idempotencyKey: string): Promise<void> {
  await db.query(
    `UPDATE cursor_dispatch
     SET cancel_confirmed = false,
         reconciliation = COALESCE(reconciliation, 'cursor_cancel_unconfirmed'),
         updated_at = now()
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
}

async function settle(
  db: Queryable,
  idempotencyKey: string,
  runId: string,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE dispatch_outbox
     SET state = 'needs_reconciliation', reconciliation = COALESCE(NULLIF(reconciliation, ''), $2)
     WHERE idempotency_key = $1 AND state = 'running'`,
    [idempotencyKey, reason],
  );
  await db.query(
    `UPDATE cursor_dispatch
     SET reconciliation = COALESCE(reconciliation, $2), updated_at = now()
     WHERE idempotency_key = $1`,
    [idempotencyKey, reason],
  );
  await db.query(
    `UPDATE runs
     SET status = 'needs_human', phase_reason = COALESCE(phase_reason, $2),
         ended_at = COALESCE(ended_at, now()), version = version + 1
     WHERE id = $1::uuid AND status = 'active'`,
    [runId, reason],
  );
}

interface HandleRow {
  idempotencyKey: string;
  runId: string;
  launch: string;
  reconciliation: string | null;
  agentId: string | null;
  providerRunId: string | null;
  outboxState: string;
  heartbeatStale: boolean;
}

async function loadHandle(
  db: Queryable,
  idempotencyKey: string,
  staleSeconds: number,
): Promise<HandleRow | null> {
  const { rows } = await db.query(
    `SELECT c.idempotency_key, c.run_id, c.launch, c.reconciliation, c.agent_id, c.provider_run_id,
            d.state AS outbox_state,
            (d.heartbeat_at IS NULL OR d.heartbeat_at < now() - ($2::int * interval '1 second')) AS heartbeat_stale
     FROM cursor_dispatch c
     JOIN dispatch_outbox d ON d.idempotency_key = c.idempotency_key
     WHERE c.idempotency_key = $1`,
    [idempotencyKey, staleSeconds],
  );
  return rows[0] ? mapHandle(rows[0]) : null;
}

async function loadLaunched(db: Queryable, runId: string): Promise<HandleRow[]> {
  const { rows } = await db.query(
    `SELECT c.idempotency_key, c.run_id, c.launch, c.reconciliation, c.agent_id, c.provider_run_id,
            d.state AS outbox_state, false AS heartbeat_stale
     FROM cursor_dispatch c
     JOIN dispatch_outbox d ON d.idempotency_key = c.idempotency_key
     WHERE c.run_id = $1::uuid AND c.launch = 'launched' AND c.provider_run_id IS NOT NULL`,
    [runId],
  );
  return rows.map((row) => mapHandle(row));
}

function mapHandle(row: Record<string, unknown>): HandleRow {
  return {
    idempotencyKey: String(row.idempotency_key),
    runId: String(row.run_id),
    launch: String(row.launch),
    reconciliation: row.reconciliation == null ? null : String(row.reconciliation),
    agentId: row.agent_id == null ? null : String(row.agent_id),
    providerRunId: row.provider_run_id == null ? null : String(row.provider_run_id),
    outboxState: String(row.outbox_state),
    heartbeatStale: row.heartbeat_stale === true || row.heartbeat_stale === "t",
  };
}

function pgCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
