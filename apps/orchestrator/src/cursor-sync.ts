import {
  CursorCloudError,
  classifyRunStatus,
  interpretCancelStatus,
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
  if (row.launch === "intent" && !row.heartbeatStale && !row.cancelRequested) return "active";
  if (row.launch === "intent") {
    await db.query(
      `UPDATE cursor_dispatch
       SET cancel_requested = true, updated_at = now()
       WHERE idempotency_key = $1 AND cancel_confirmed = false`,
      [idempotencyKey],
    );
    await settle(db, idempotencyKey, row.runId, row.reconciliation ?? "cursor_launch_unconfirmed");
    return "reconciled";
  }
  if (row.launch === "refused" || row.launch === "ambiguous") {
    await settle(db, idempotencyKey, row.runId, row.reconciliation ?? "cursor_launch_ambiguous");
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

/** At most this many status/cancel HTTP attempts per handle. */
export const MAX_CANCEL_ATTEMPTS = 5;

/**
 * Record cancel intent for every handle on the run, including intent and
 * unknown rows, then try once. Later ticks call `reconcileCursorCancels`.
 * `cancel_confirmed` stays false until Get A Run returns CANCELLED.
 */
export async function cancelCursorRuns(
  db: Queryable,
  runId: string,
  client: CursorCloudClient | null,
): Promise<void> {
  try {
    await db.query(
      `UPDATE cursor_dispatch
       SET cancel_requested = true,
           reconciliation = COALESCE(reconciliation, 'cursor_cancel_requested'),
           updated_at = now()
       WHERE run_id = $1::uuid AND cancel_confirmed = false`,
      [runId],
    );
  } catch (err) {
    if (pgCode(err) === "42P01" || pgCode(err) === "42703") return;
    throw err;
  }
  await reconcileCursorCancels(db, client, 5);
}

/**
 * Bounded status/cancel pass. It does not require the local run to be active
 * and it never calls create. A row that is not yet CANCELLED stays visible.
 */
export async function reconcileCursorCancels(
  db: Queryable,
  client: CursorCloudClient | null,
  limit: number,
): Promise<number> {
  let rows: CancelRow[];
  try {
    rows = await loadDueCancels(db, limit);
  } catch (err) {
    if (pgCode(err) === "42P01" || pgCode(err) === "42703") return 0;
    throw err;
  }
  for (const row of rows) {
    await pursueOne(db, client, row);
  }
  return rows.length;
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

async function pursueOne(
  db: Queryable,
  client: CursorCloudClient | null,
  row: CancelRow,
): Promise<void> {
  if (!client) {
    await scheduleRetry(db, row, "cursor_cancel_unavailable");
    return;
  }
  let agentId = row.agentId;
  let providerRunId = row.providerRunId;
  if (!agentId || !providerRunId) {
    try {
      const agent = await client.getAgent(row.intendedAgentId);
      if (!agent.latestRunId) {
        await scheduleRetry(db, row, "cursor_identity_unknown");
        return;
      }
      agentId = agent.id;
      providerRunId = agent.latestRunId;
      await db.query(
        `UPDATE cursor_dispatch
         SET launch = 'launched', agent_id = $2, provider_run_id = $3, agent_url = $4, updated_at = now()
         WHERE idempotency_key = $1`,
        [row.idempotencyKey, agentId, providerRunId, agent.url ?? null],
      );
    } catch (err) {
      const reason =
        err instanceof CursorCloudError && err.kind === "not_found"
          ? "cursor_identity_unknown"
          : "cursor_status_ambiguous";
      await scheduleRetry(db, row, reason);
      return;
    }
  }
  try {
    await client.cancelRun(agentId, providerRunId);
  } catch (err) {
    if (
      !(
        err instanceof CursorCloudError &&
        err.kind === "conflict" &&
        err.code === "run_not_cancellable"
      )
    ) {
      await scheduleRetry(db, row, "cursor_cancel_unconfirmed");
      return;
    }
  }
  try {
    const observed = await client.getRun(agentId, providerRunId);
    await applyCancelObservation(db, row, observed);
  } catch {
    await scheduleRetry(db, row, "cursor_cancel_unconfirmed");
  }
}

async function applyCancelObservation(
  db: Queryable,
  row: CancelRow,
  run: CursorRun,
): Promise<void> {
  const git = readProviderGit(run);
  const verdict = interpretCancelStatus(run.status);
  const reason =
    verdict === "confirmed"
      ? "cursor_cancel_confirmed"
      : verdict === "too_late"
        ? `cursor_cancel_too_late_${run.status}`
        : "cursor_cancel_unconfirmed";
  await db.query(
    `UPDATE cursor_dispatch
     SET provider_status = $2,
         repo_url = COALESCE($3, repo_url),
         branch = COALESCE($4, branch),
         pr_url = COALESCE($5, pr_url),
         result_text = COALESCE($6, result_text),
         cancel_confirmed = $7,
         cancel_closed = $8,
         reconciliation = $9,
         updated_at = now()
     WHERE idempotency_key = $1 AND cancel_confirmed = false`,
    [
      row.idempotencyKey,
      run.status,
      git?.repoUrl ?? null,
      git?.branch ?? null,
      git?.prUrl ?? null,
      run.result ?? null,
      verdict === "confirmed",
      verdict !== "pending",
      reason,
    ],
  );
  if (verdict === "pending") {
    await scheduleRetry(db, row, reason);
    return;
  }
  await keepVisible(db, row.runId, row.idempotencyKey, reason);
}

async function scheduleRetry(db: Queryable, row: CancelRow, reason: string): Promise<void> {
  await db.query(
    `UPDATE cursor_dispatch
     SET cancel_attempts = cancel_attempts + 1,
         next_reconcile_at = now() + ((cancel_attempts + 1) * interval '1 second'),
         cancel_confirmed = false,
         cancel_closed = (cancel_attempts + 1) >= $3,
         reconciliation = CASE
           WHEN (cancel_attempts + 1) >= $3 THEN 'cursor_cancel_exhausted'
           ELSE $2
         END,
         updated_at = now()
     WHERE idempotency_key = $1 AND cancel_confirmed = false AND cancel_closed = false`,
    [row.idempotencyKey, reason, MAX_CANCEL_ATTEMPTS],
  );
  const visible =
    row.cancelAttempts + 1 >= MAX_CANCEL_ATTEMPTS ? "cursor_cancel_exhausted" : reason;
  await keepVisible(db, row.runId, row.idempotencyKey, visible);
}

async function keepVisible(
  db: Queryable,
  runId: string,
  idempotencyKey: string,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE dispatch_outbox
     SET state = 'needs_reconciliation', reconciliation = COALESCE(NULLIF(reconciliation, ''), $2)
     WHERE idempotency_key = $1 AND state = 'running'`,
    [idempotencyKey, reason],
  );
  await db.query(
    `UPDATE runs
     SET status = 'needs_human',
         phase_reason = COALESCE(phase_reason, $2),
         ended_at = COALESCE(ended_at, now()),
         version = version + 1
     WHERE id = $1::uuid AND status = 'active'`,
    [runId, reason],
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
  cancelRequested: boolean;
}

interface CancelRow {
  idempotencyKey: string;
  runId: string;
  intendedAgentId: string;
  agentId: string | null;
  providerRunId: string | null;
  cancelAttempts: number;
}

async function loadHandle(
  db: Queryable,
  idempotencyKey: string,
  staleSeconds: number,
): Promise<HandleRow | null> {
  const { rows } = await db.query(
    `SELECT c.idempotency_key, c.run_id, c.launch, c.reconciliation, c.agent_id, c.provider_run_id,
            c.cancel_requested,
            d.state AS outbox_state,
            (d.heartbeat_at IS NULL OR d.heartbeat_at < now() - ($2::int * interval '1 second')) AS heartbeat_stale
     FROM cursor_dispatch c
     JOIN dispatch_outbox d ON d.idempotency_key = c.idempotency_key
     WHERE c.idempotency_key = $1`,
    [idempotencyKey, staleSeconds],
  );
  return rows[0] ? mapHandle(rows[0]) : null;
}

async function loadDueCancels(db: Queryable, limit: number): Promise<CancelRow[]> {
  const { rows } = await db.query(
    `SELECT idempotency_key, run_id, intended_agent_id, agent_id, provider_run_id, cancel_attempts
     FROM cursor_dispatch
     WHERE cancel_requested = true
       AND cancel_confirmed = false
       AND cancel_closed = false
       AND (next_reconcile_at IS NULL OR next_reconcile_at <= now())
     ORDER BY updated_at
     LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    idempotencyKey: String(row.idempotency_key),
    runId: String(row.run_id),
    intendedAgentId: String(row.intended_agent_id),
    agentId: row.agent_id == null ? null : String(row.agent_id),
    providerRunId: row.provider_run_id == null ? null : String(row.provider_run_id),
    cancelAttempts: Number(row.cancel_attempts ?? 0),
  }));
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
    cancelRequested: row.cancel_requested === true || row.cancel_requested === "t",
  };
}

function pgCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
