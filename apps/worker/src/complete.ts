import { agentJobId, parseAgentJobPayload } from "@gb/shared";
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
export async function executeQueuedJob(
  db: Queryable | undefined,
  name: string,
  data: unknown,
): Promise<ExecuteResult> {
  if (!db) {
    return { executed: false, reason: "durable_store_required", result: null };
  }
  return completeDispatchOnce(db, name, data);
}

/**
 * Claim `running` only while the run is active and inside its deadline.
 * The stub handler then runs. A second delivery does not enter the handler.
 * Cancellation or expiry observed after the handler is `needs_reconciliation`
 * with externalEffect `unknown`: this does not stop an external call that
 * already started. A crash after `running` and before finish stays `running`
 * until the orchestrator marks `needs_reconciliation`.
 */
export async function completeDispatchOnce(
  db: Queryable,
  name: string,
  data: unknown,
): Promise<ExecuteResult> {
  const payload = parseAgentJobPayload(data);
  const key = payload ? agentJobId(payload) : null;
  if (!key) {
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
  const result = handleAgentJob(name, data, { cancelled: () => cancel });
  const finish = await finishDispatch(db, key);
  if (finish === "needs_reconciliation") {
    return {
      executed: true,
      reason: "needs_reconciliation",
      result: { ...result, externalEffect: "unknown" },
    };
  }
  return { executed: true, result };
}

export async function finishDispatch(
  db: Queryable,
  idempotencyKey: string,
): Promise<"completed" | "needs_reconciliation"> {
  const blocked = await db.query(
    `UPDATE dispatch_outbox AS d
     SET state = 'needs_reconciliation', reconciliation = 'external_effect_unknown'
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
    await db.query(
      `UPDATE runs
       SET status = 'needs_human', phase_reason = 'needs_reconciliation',
           ended_at = COALESCE(ended_at, now()), version = version + 1
       WHERE id = $1 AND status = 'active'`,
      [blocked.rows[0]?.run_id],
    );
    return "needs_reconciliation";
  }
  await db.query(
    `UPDATE dispatch_outbox
     SET state = 'completed', completed_at = now()
     WHERE idempotency_key = $1 AND state = 'running'`,
    [idempotencyKey],
  );
  return "completed";
}
