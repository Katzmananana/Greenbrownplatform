import {
  CursorCloudError,
  buildCreateAgentBody,
  classifyRunStatus,
  cursorAgentIdForDispatch,
  readProviderGit,
  type CursorCloudClient,
  type CursorExecutorConfig,
  type CursorRun,
} from "@gb/cursor-cloud";
import type { AgentJobPayload } from "@gb/shared";

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export type CodingDisposition =
  | { disposition: "refused"; reason: string }
  | { disposition: "active" }
  | { disposition: "ambiguous"; reason: string }
  | { disposition: "finished" }
  | { disposition: "terminal"; reason: string };

/**
 * Launch or resume one code/fix dispatch against Cursor Cloud Agents v1.
 * A missing config, credential, allowlist, plan, CP1 approval, or positive
 * local budget never calls the network. An ambiguous create is stored and
 * is not posted again. Git repo, branch, and PR URL are copied only from the
 * provider payload, and only when the repo is the allowlisted one.
 * `commit_sha` is left null: Get A Run does not document a commit field.
 * This does not set `execution_mode` or write `run_evidence`.
 */
export async function executeCursorCodingJob(
  db: Queryable,
  idempotencyKey: string,
  payload: AgentJobPayload,
  config: CursorExecutorConfig,
  client: CursorCloudClient | null,
): Promise<CodingDisposition> {
  if (config.mode === "off") return { disposition: "refused", reason: "cursor_executor_off" };
  if (config.mode === "refused") return refuse(db, idempotencyKey, payload, config.reason);
  if (!client) return refuse(db, idempotencyKey, payload, "cursor_credential_missing");

  const gate = await loadGate(db, idempotencyKey);
  if (!gate.ok) return refuse(db, idempotencyKey, payload, gate.reason);

  const existing = await loadHandle(db, idempotencyKey);
  if (existing?.launch === "ambiguous" || existing?.launch === "refused") {
    const reason = existing.reconciliation ?? "cursor_launch_ambiguous";
    await settle(db, idempotencyKey, payload.runId, reason);
    return existing.launch === "refused"
      ? { disposition: "refused", reason }
      : { disposition: "ambiguous", reason };
  }
  if (existing?.launch === "launched" && existing.agentId && existing.providerRunId) {
    try {
      const run = await client.getRun(existing.agentId, existing.providerRunId);
      return storeRun(db, idempotencyKey, payload.runId, run);
    } catch (err) {
      const reason =
        err instanceof CursorCloudError ? `cursor_status_${err.kind}` : "cursor_status_ambiguous";
      await markAmbiguous(db, idempotencyKey, payload.runId, reason);
      return { disposition: "ambiguous", reason };
    }
  }

  const intended = cursorAgentIdForDispatch(idempotencyKey);
  if (!existing) {
    await db.query(
      `INSERT INTO cursor_dispatch
         (idempotency_key, run_id, intended_agent_id, launch)
       VALUES ($1, $2::uuid, $3, 'intent')`,
      [idempotencyKey, payload.runId, intended],
    );
  }

  const body = buildCreateAgentBody({
    idempotencyKey,
    requestText: gate.requestText,
    planText: gate.planText,
    repoUrl: config.repoUrl,
    startingRef: config.startingRef,
    runId: payload.runId,
  });

  try {
    const created = await client.createAgent(body);
    await rememberLaunch(db, idempotencyKey, created.agent.id, created.run.id, created.agent.url);
    return applyRun(db, idempotencyKey, payload.runId, created.run, client);
  } catch (err) {
    if (err instanceof CursorCloudError && err.kind === "conflict") {
      return adoptExisting(db, idempotencyKey, payload.runId, intended, client);
    }
    const reason =
      err instanceof CursorCloudError ? `cursor_launch_${err.kind}` : "cursor_launch_ambiguous";
    await markAmbiguous(db, idempotencyKey, payload.runId, reason);
    return { disposition: "ambiguous", reason };
  }
}

async function adoptExisting(
  db: Queryable,
  idempotencyKey: string,
  runId: string,
  intended: string,
  client: CursorCloudClient,
): Promise<CodingDisposition> {
  try {
    const agent = await client.getAgent(intended);
    if (!agent.latestRunId) {
      await markAmbiguous(db, idempotencyKey, runId, "cursor_launch_conflict_no_run");
      return { disposition: "ambiguous", reason: "cursor_launch_conflict_no_run" };
    }
    await rememberLaunch(db, idempotencyKey, agent.id, agent.latestRunId, agent.url);
    const run = await client.getRun(agent.id, agent.latestRunId);
    return applyRun(db, idempotencyKey, runId, run, client);
  } catch (err) {
    const reason =
      err instanceof CursorCloudError ? `cursor_launch_${err.kind}` : "cursor_launch_ambiguous";
    await markAmbiguous(db, idempotencyKey, runId, reason);
    return { disposition: "ambiguous", reason };
  }
}

async function applyRun(
  db: Queryable,
  idempotencyKey: string,
  runId: string,
  run: CursorRun,
  client: CursorCloudClient,
): Promise<CodingDisposition> {
  let current = run;
  if (classifyRunStatus(run.status) === "active") {
    try {
      current = await client.getRun(run.agentId, run.id);
    } catch (err) {
      if (err instanceof CursorCloudError && err.kind === "unavailable") {
        await touchStatus(db, idempotencyKey, run.status);
        return { disposition: "active" };
      }
      const reason =
        err instanceof CursorCloudError ? `cursor_status_${err.kind}` : "cursor_status_ambiguous";
      await markAmbiguous(db, idempotencyKey, runId, reason);
      return { disposition: "ambiguous", reason };
    }
  }
  return storeRun(db, idempotencyKey, runId, current);
}

export async function storeRun(
  db: Queryable,
  idempotencyKey: string,
  runId: string,
  run: CursorRun,
): Promise<CodingDisposition> {
  const kind = classifyRunStatus(run.status);
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
  if (kind === "active") {
    await touchStatus(db, idempotencyKey, run.status);
    return { disposition: "active" };
  }
  if (kind === "finished") {
    if (!git) {
      await markAmbiguous(db, idempotencyKey, runId, "cursor_artifact_missing");
      return { disposition: "terminal", reason: "cursor_artifact_missing" };
    }
    await db.query(
      `UPDATE dispatch_outbox SET heartbeat_at = now() WHERE idempotency_key = $1 AND state = 'running'`,
      [idempotencyKey],
    );
    return { disposition: "finished" };
  }
  const reason = kind === "terminal" ? `cursor_run_${run.status}` : "cursor_status_unrecognized";
  await markAmbiguous(db, idempotencyKey, runId, reason);
  return { disposition: kind === "terminal" ? "terminal" : "ambiguous", reason };
}

async function refuse(
  db: Queryable,
  idempotencyKey: string,
  payload: AgentJobPayload,
  reason: string,
): Promise<CodingDisposition> {
  const intended = cursorAgentIdForDispatch(idempotencyKey);
  await db.query(
    `INSERT INTO cursor_dispatch
       (idempotency_key, run_id, intended_agent_id, launch, reconciliation)
     VALUES ($1, $2::uuid, $3, 'refused', $4)
     ON CONFLICT (idempotency_key) DO UPDATE
       SET launch = 'refused', reconciliation = EXCLUDED.reconciliation, updated_at = now()`,
    [idempotencyKey, payload.runId, intended, reason],
  );
  await settle(db, idempotencyKey, payload.runId, reason);
  return { disposition: "refused", reason };
}

async function markAmbiguous(
  db: Queryable,
  idempotencyKey: string,
  runId: string,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE cursor_dispatch
     SET launch = 'ambiguous', reconciliation = $2, updated_at = now()
     WHERE idempotency_key = $1 AND launch <> 'launched'`,
    [idempotencyKey, reason],
  );
  await db.query(
    `UPDATE cursor_dispatch
     SET reconciliation = COALESCE(reconciliation, $2), updated_at = now()
     WHERE idempotency_key = $1 AND launch = 'launched'`,
    [idempotencyKey, reason],
  );
  await settle(db, idempotencyKey, runId, reason);
}

async function rememberLaunch(
  db: Queryable,
  idempotencyKey: string,
  agentId: string,
  runId: string,
  agentUrl: string | undefined,
): Promise<void> {
  await db.query(
    `UPDATE cursor_dispatch
     SET launch = 'launched', agent_id = $2, provider_run_id = $3, agent_url = $4, updated_at = now()
     WHERE idempotency_key = $1`,
    [idempotencyKey, agentId, runId, agentUrl ?? null],
  );
}

async function touchStatus(db: Queryable, idempotencyKey: string, status: string): Promise<void> {
  await db.query(
    `UPDATE cursor_dispatch SET provider_status = $2, updated_at = now() WHERE idempotency_key = $1`,
    [idempotencyKey, status],
  );
  await db.query(
    `UPDATE dispatch_outbox SET heartbeat_at = now() WHERE idempotency_key = $1 AND state = 'running'`,
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
    `UPDATE runs
     SET status = 'needs_human', phase_reason = $2,
         ended_at = COALESCE(ended_at, now()), version = version + 1
     WHERE id = $1::uuid AND status = 'active'`,
    [runId, reason],
  );
}

async function loadHandle(
  db: Queryable,
  idempotencyKey: string,
): Promise<{
  launch: string;
  reconciliation: string | null;
  agentId: string | null;
  providerRunId: string | null;
} | null> {
  const { rows } = await db.query(
    `SELECT launch, reconciliation, agent_id, provider_run_id FROM cursor_dispatch WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    launch: String(row.launch),
    reconciliation: row.reconciliation == null ? null : String(row.reconciliation),
    agentId: row.agent_id == null ? null : String(row.agent_id),
    providerRunId: row.provider_run_id == null ? null : String(row.provider_run_id),
  };
}

async function loadGate(
  db: Queryable,
  idempotencyKey: string,
): Promise<{ ok: true; requestText: string; planText: string } | { ok: false; reason: string }> {
  const { rows } = await db.query(
    `SELECT r.plan_text, q.text AS request_text, d.cost_usd,
            o.max_cost_usd, o.max_cost_usd_per_run,
            (SELECT COALESCE(SUM(cost_usd), 0)::float8 FROM credit_ledger WHERE org_id = d.org_id) AS org_spend,
            EXISTS (
              SELECT 1 FROM approvals a
              WHERE a.request_id = r.request_id AND a.checkpoint = 'CP1' AND a.decision = 'approved'
            ) AS cp1
     FROM dispatch_outbox d
     JOIN runs r ON r.id = d.run_id
     LEFT JOIN requests q ON q.id = r.request_id
     LEFT JOIN org_config o ON o.org_id = d.org_id
     WHERE d.idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "cursor_dispatch_missing" };
  const plan = typeof row.plan_text === "string" ? row.plan_text.trim() : "";
  const request = typeof row.request_text === "string" ? row.request_text.trim() : "";
  if (!row.cp1) return { ok: false, reason: "cursor_cp1_required" };
  if (!plan) return { ok: false, reason: "cursor_plan_missing" };
  if (!request) return { ok: false, reason: "cursor_request_missing" };
  const cost = Number(row.cost_usd ?? 0);
  const maxOrg = Number(row.max_cost_usd ?? 0);
  const maxRun = Number(row.max_cost_usd_per_run ?? 0);
  const spent = Number(row.org_spend ?? 0);
  if (!(cost > 0) || !(maxOrg > 0) || !(maxRun > 0) || spent > maxOrg) {
    return { ok: false, reason: "cursor_budget_required" };
  }
  return { ok: true, requestText: request, planText: plan };
}
