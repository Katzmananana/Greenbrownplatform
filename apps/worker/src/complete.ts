import type { CursorCloudClient, CursorExecutorConfig } from "@gb/cursor-cloud";
import { agentJobId, parseAgentJobPayload, type AgentJobPayload } from "@gb/shared";
import { executeCursorCodingJob } from "./cursor-job.js";
import { handleAgentJob, type HandledJob } from "./handle.js";

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export type ExecuteResult = {
  executed: boolean;
  reason?: "durable_store_required" | "not_runnable" | "needs_reconciliation";
  result: (HandledJob & { externalEffect: "none" | "unknown" }) | null;
};

/**
 * Job execution without a durable store is refused. The handler is not called.
 */
export interface CodingExecutor {
  config: CursorExecutorConfig;
  client: CursorCloudClient | null;
}

export async function executeQueuedJob(
  db: Queryable | undefined,
  name: string,
  data: unknown,
  coding?: CodingExecutor | null,
): Promise<ExecuteResult> {
  if (!db) {
    return { executed: false, reason: "durable_store_required", result: null };
  }
  return completeDispatchOnce(db, name, data, undefined, coding);
}

export interface DispatchHooks {
  /**
   * Runs after the stub handler returns and before the durable finish.
   * Tests use it to expire or halt the run in that window. Production does not.
   */
  afterHandler?: () => Promise<void>;
}

/**
 * Claim `running` only while the run is active and inside its deadline.
 * The stub handler then runs. A second delivery does not enter the handler.
 * Cancellation or expiry observed after the handler is `needs_reconciliation`
 * with externalEffect `unknown`: this does not stop an external call that
 * already started. Finish reports `completed` only when this call's update
 * changes a still-active `running` row. A crash after `running` and before
 * finish stays `running` until the orchestrator marks `needs_reconciliation`.
 */
export async function completeDispatchOnce(
  db: Queryable,
  name: string,
  data: unknown,
  hooks?: DispatchHooks,
  coding?: CodingExecutor | null,
): Promise<ExecuteResult> {
  const payload = parseAgentJobPayload(data);
  const key = payload ? agentJobId(payload) : null;
  if (!payload || !key) {
    return { executed: false, reason: "not_runnable", result: null };
  }
  const claimed = await db.query(
    `UPDATE dispatch_outbox AS d
     SET state = 'running', executions = executions + 1, heartbeat_at = now()
     FROM runs AS r
     WHERE d.idempotency_key = $1
       AND d.run_id = r.id
       AND d.state IN ('pending', 'enqueued')
       AND d.executions = 0
       AND r.status = 'active'
       AND (r.deadline_at IS NULL OR r.deadline_at > now())
     RETURNING d.executions`,
    [key],
  );
  if (claimed.rows.length === 0) {
    return { executed: false, reason: "not_runnable", result: null };
  }
  const cancel = false;
  const useCursor =
    coding != null &&
    coding.config.mode !== "off" &&
    (payload.name === "code" || payload.name === "fix");
  if (useCursor) {
    const outcome = await executeCursorCodingJob(db, key, payload, coding.config, coding.client);
    if (hooks?.afterHandler) await hooks.afterHandler();
    const effect = outcome.disposition === "refused" ? "none" : "unknown";
    const coded = codedResult(payload, effect);
    if (outcome.disposition === "active") {
      return { executed: true, result: coded };
    }
    const finish = await finishDispatch(db, key);
    if (finish === "needs_reconciliation" || outcome.disposition !== "finished") {
      return { executed: true, reason: "needs_reconciliation", result: coded };
    }
    return { executed: true, result: coded };
  }
  const result = handleAgentJob(name, data, { cancelled: () => cancel });
  if (hooks?.afterHandler) await hooks.afterHandler();
  const finish = await finishDispatch(db, key);
  if (finish === "needs_reconciliation") {
    console.log(
      JSON.stringify({
        msg: "worker finish needs_reconciliation",
        runId: result.runId,
        externalEffect: "unknown",
      }),
    );
    return {
      executed: true,
      reason: "needs_reconciliation",
      result: { ...result, externalEffect: "unknown" },
    };
  }
  return { executed: true, result };
}

/**
 * Finish one claimed dispatch. `completed` is returned only when this call
 * updates a `running` row whose run is still active and inside its deadline.
 * An already-reconciled row is left as it is, including its cause. A `cancelled`
 * row that already executed is repaired to `needs_reconciliation` instead of
 * being reported complete. Neither path claims an external call was stopped.
 */
export async function finishDispatch(
  db: Queryable,
  idempotencyKey: string,
): Promise<"completed" | "needs_reconciliation"> {
  const blocked = await db.query(
    `UPDATE dispatch_outbox AS d
     SET state = 'needs_reconciliation',
         reconciliation = COALESCE(NULLIF(d.reconciliation, ''), 'external_effect_unknown')
     FROM runs AS r
     WHERE d.idempotency_key = $1
       AND d.run_id = r.id
       AND d.state = 'running'
       AND (
         r.status <> 'active'
         OR (r.deadline_at IS NOT NULL AND r.deadline_at <= now())
       )
     RETURNING d.run_id`,
    [idempotencyKey],
  );
  if (blocked.rows.length > 0) {
    await noteUnknownEffect(db, blocked.rows[0]?.run_id);
    return "needs_reconciliation";
  }
  const completed = await db.query(
    `UPDATE dispatch_outbox AS d
     SET state = 'completed', completed_at = now()
     FROM runs AS r
     WHERE d.idempotency_key = $1
       AND d.run_id = r.id
       AND d.state = 'running'
       AND (d.reconciliation IS NULL OR d.reconciliation = '')
       AND r.status = 'active'
       AND (r.deadline_at IS NULL OR r.deadline_at > now())
     RETURNING d.idempotency_key`,
    [idempotencyKey],
  );
  if (completed.rows.length > 0) return "completed";

  const repaired = await db.query(
    `UPDATE dispatch_outbox
     SET state = 'needs_reconciliation',
         reconciliation = COALESCE(NULLIF(reconciliation, ''), 'external_effect_unknown')
     WHERE idempotency_key = $1
       AND state = 'cancelled'
       AND executions > 0
     RETURNING run_id`,
    [idempotencyKey],
  );
  if (repaired.rows.length > 0) {
    await noteUnknownEffect(db, repaired.rows[0]?.run_id);
    return "needs_reconciliation";
  }

  const current = await db.query(`SELECT state FROM dispatch_outbox WHERE idempotency_key = $1`, [
    idempotencyKey,
  ]);
  if (current.rows[0]?.state === "completed") return "completed";
  return "needs_reconciliation";
}

function codedResult(
  payload: AgentJobPayload,
  externalEffect: "none" | "unknown",
): ExecuteResult["result"] {
  return {
    ok: true,
    stub: false,
    provider: "cursor_cloud_agents_v1",
    name: payload.name,
    runId: payload.runId,
    requestId: payload.requestId,
    iteration: payload.iteration,
    role: payload.role,
    externalEffect,
  };
}

async function noteUnknownEffect(db: Queryable, runId: unknown): Promise<void> {
  if (runId == null) return;
  await db.query(
    `UPDATE runs
     SET status = 'needs_human', phase_reason = 'needs_reconciliation',
         ended_at = COALESCE(ended_at, now()), version = version + 1
     WHERE id = $1 AND status = 'active'`,
    [runId],
  );
}
