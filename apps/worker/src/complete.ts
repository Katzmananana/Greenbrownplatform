import { agentJobId, parseAgentJobPayload } from "@gb/shared";
import { handleAgentJob, type HandledJob } from "./handle.js";

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * Take the completion row before the stub side effect. A second delivery
 * matches zero rows and does not run the handler again. This is at-most-once
 * for the stub: a crash after the row is taken does not re-run the handler,
 * and a deleted Redis result cannot cause another execution.
 */
export async function completeDispatchOnce(
  db: Queryable,
  name: string,
  data: unknown,
): Promise<{ result: HandledJob; executed: boolean }> {
  const payload = parseAgentJobPayload(data);
  const key = payload ? agentJobId(payload) : null;
  if (!key) return { result: handleAgentJob(name, data), executed: true };
  const claimed = await db.query(
    `UPDATE dispatch_outbox
     SET state = 'running', executions = executions + 1
     WHERE idempotency_key = $1 AND state IN ('pending', 'enqueued') AND executions = 0
     RETURNING executions`,
    [key],
  );
  if (claimed.rows.length === 0) {
    return {
      executed: false,
      result: {
        ok: true,
        stub: true,
        name: payload?.name ?? name,
        runId: payload?.runId ?? null,
        requestId: payload?.requestId ?? null,
        iteration: payload?.iteration ?? null,
        role: payload?.role ?? null,
      },
    };
  }
  const result = handleAgentJob(name, data);
  await db.query(
    `UPDATE dispatch_outbox
     SET state = 'completed', completed_at = now()
     WHERE idempotency_key = $1 AND state = 'running'`,
    [key],
  );
  return { executed: true, result };
}
