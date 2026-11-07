import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue, Worker } from "bullmq";
import { defaultLabOrgConfig } from "@gb/credits";
import { JOB_QUEUE_NAME, agentJobId, bullmqConnectionFromUrl } from "@gb/shared";
import { signHumanJwt } from "../../gateway/src/mcp/human-auth.js";
import { createApp } from "../../gateway/src/app.js";
import { PostgresRunStore } from "../../gateway/src/store/postgres.js";
import { completeDispatchOnce, finishDispatch } from "../../worker/src/complete.js";
import { createBullDispatcher } from "../src/bull.js";
import { runTick } from "../src/loop.js";
import { createPostgresRepository } from "../src/postgres.js";
import type { RunSnapshot } from "../src/types.js";

const databaseUrl = process.env.GB_TEST_DATABASE_URL;
const redisUrl = process.env.GB_TEST_REDIS_URL;

if (process.env.GB_REQUIRE_SAFETY_INTEGRATION === "1" && (!databaseUrl || !redisUrl)) {
  throw new Error(
    "GB_REQUIRE_SAFETY_INTEGRATION=1 requires GB_TEST_DATABASE_URL and GB_TEST_REDIS_URL",
  );
}
const FIXTURE_KEY = "hmac-fixture-key";
const ORG = "00000000-0000-4000-8000-0000000000a1";
const migrations = ["001_init.sql", "002_requests.sql", "003_run_phase.sql", "004_safety.sql"];

describe.skipIf(!databaseUrl || !redisUrl)("safety integration (postgres + redis)", () => {
  let repo: Awaited<ReturnType<typeof createPostgresRepository>>;
  let store: PostgresRunStore;
  let pool: {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
    end(): Promise<void>;
  };
  let queue: Queue;
  let worker: Worker;
  let jobs: ReturnType<typeof createBullDispatcher>;

  beforeAll(async () => {
    const pg = (await import("pg")).default;
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    const ready = await pool.query(`SELECT to_regclass('public.dispatch_outbox') AS name`);
    if (!ready.rows[0]?.name) {
      for (const file of migrations) {
        if (file === "004_safety.sql") continue;
        const sql = readFileSync(
          new URL(`../../../db/migrations/${file}`, import.meta.url),
          "utf8",
        );
        await pool.query(sql);
      }
    }
    const safety = readFileSync(
      new URL("../../../db/migrations/004_safety.sql", import.meta.url),
      "utf8",
    );
    await pool.query(safety);
    repo = await createPostgresRepository(databaseUrl!);
    store = new PostgresRunStore(pool as never);
    jobs = createBullDispatcher(redisUrl!);
    queue = new Queue(JOB_QUEUE_NAME, { connection: bullmqConnectionFromUrl(redisUrl!) });
    worker = new Worker(
      JOB_QUEUE_NAME,
      async (job) => {
        const done = await completeDispatchOnce(pool, job.name, job.data);
        return done.result;
      },
      { connection: bullmqConnectionFromUrl(redisUrl!) },
    );
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await jobs?.close();
    await queue?.close();
    await repo?.close();
    await pool?.end();
  });

  async function reset(): Promise<void> {
    await pool.query(
      `TRUNCATE run_evidence, dispatch_outbox, credit_ledger, approvals, runs, requests, org_config RESTART IDENTITY CASCADE`,
    );
    await pool.query(
      `INSERT INTO org_config (org_id, max_cost_usd, max_cost_usd_per_run, max_fix_iterations, max_allowed_iterations,
         per_role_budget_usd, max_wall_clock_seconds, required_checks)
       VALUES ($1::uuid, 10, 10, 1, 1, '{"planner":10,"coder":10,"fixer":10}'::jsonb, 3600, ARRAY['unit']::text[])`,
      [ORG],
    );
    const jobs = await queue.getJobs(["waiting", "active", "completed", "failed", "delayed"]);
    await Promise.all(jobs.map((job) => job.remove().catch(() => undefined)));
  }

  function human(authTime = Math.floor(Date.now() / 1000)): string {
    const now = Math.floor(Date.now() / 1000);
    return `Bearer ${signHumanJwt(FIXTURE_KEY, { sub: "human-fixture", authTime, exp: now + 120 })}`;
  }

  async function tick(estimateUsd = 1, gateRunner?: () => { name: string; passed: boolean }[]) {
    return runTick({
      repo,
      jobs,
      now: new Date(),
      leaseSeconds: 5,
      batchSize: 10,
      estimateUsd,
      ...(gateRunner ? { gateRunner } : {}),
    });
  }

  async function executions(runId: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(executions), 0)::int AS n FROM dispatch_outbox WHERE run_id = $1`,
      [runId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async function loadSnap(runId: string): Promise<RunSnapshot> {
    const { rows } = await pool.query(
      `SELECT id, request_id, status, phase, phase_reason, iteration, version, started_at, deadline_at, execution_mode
       FROM runs WHERE id = $1`,
      [runId],
    );
    const row = rows[0];
    if (!row) throw new Error(`run ${runId} missing`);
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      requestText: null,
      status: row.status,
      phase: row.phase,
      phaseReason: row.phase_reason == null ? null : String(row.phase_reason),
      iteration: Number(row.iteration ?? 0),
      version: Number(row.version ?? 0),
      startedAt: new Date(row.started_at).toISOString(),
      deadlineAt: row.deadline_at ? new Date(row.deadline_at).toISOString() : null,
      approved: [],
      executionMode: row.execution_mode === "live" ? "live" : "simulation",
      evidenceReady: false,
    };
  }

  async function outbox(idempotencyKey: string): Promise<{
    state: string;
    reconciliation: string | null;
    executions: number;
  }> {
    const { rows } = await pool.query(
      `SELECT state, reconciliation, executions FROM dispatch_outbox WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = rows[0];
    if (!row) throw new Error(`outbox ${idempotencyKey} missing`);
    return {
      state: String(row.state),
      reconciliation: row.reconciliation == null ? null : String(row.reconciliation),
      executions: Number(row.executions ?? 0),
    };
  }

  async function seedRunning(label: string): Promise<{
    run: { runId: string; requestId: string };
    key: string;
    payload: {
      v: 1;
      name: "plan";
      role: "planner";
      runId: string;
      requestId: string;
      iteration: 0;
      requestText: null;
    };
  }> {
    const run = await store.createRun({ request: label });
    await pool.query(`UPDATE runs SET phase = 'planning' WHERE id = $1`, [run.runId]);
    const payload = {
      v: 1 as const,
      name: "plan" as const,
      role: "planner" as const,
      runId: run.runId,
      requestId: run.requestId,
      iteration: 0 as const,
      requestText: null,
    };
    const key = agentJobId(payload);
    await pool.query(
      `INSERT INTO dispatch_outbox
         (idempotency_key, org_id, run_id, request_id, job_name, role, iteration, payload, cost_usd, state, executions, heartbeat_at)
       VALUES ($1, $2::uuid, $3, $4, 'plan', 'planner', 0, $5::jsonb, 1, 'running', 1, now())`,
      [key, ORG, run.runId, run.requestId, JSON.stringify(payload)],
    );
    return { run, key, payload };
  }

  async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 40; i += 1) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("timed out waiting for condition");
  }

  it("rejects early, duplicate, and agent approvals; stores token auth_time", async () => {
    await reset();
    const { createServer } = await import("node:http");
    let url = "";
    const app = createApp({
      runStore: store,
      mcpAuth: { token: "agent-token", nodeEnv: "test" },
      humanAuth: { secret: FIXTURE_KEY, maxAgeSeconds: 300, agentCredential: "agent-token" },
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    url = `http://127.0.0.1:${address.port}`;
    const call = async (args: unknown, humanHeader?: string) => {
      const res = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer agent-token",
          ...(humanHeader ? { "x-gb-human-authorization": humanHeader } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "approve", arguments: args },
        }),
      });
      return (await res.json()) as {
        result: { structuredContent: { error?: string; status?: string } };
      };
    };
    const created = await store.createRun({ request: "safety" });
    expect(
      (await call({ runId: created.runId, checkpoint: "CP1" })).result.structuredContent.error,
    ).toBe("human_auth_required");
    expect(
      (await call({ runId: created.runId, checkpoint: "CP1" }, "Bearer agent-token")).result
        .structuredContent.error,
    ).toBe("human_auth_invalid");
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect(
      (await call({ runId: created.runId, checkpoint: "CP1" }, human(stale))).result
        .structuredContent.error,
    ).toBe("human_auth_stale");
    const authTime = Math.floor(Date.now() / 1000) - 30;
    expect(
      (await call({ runId: created.runId, checkpoint: "CP1" }, human(authTime))).result
        .structuredContent.error,
    ).toBe("not_ready");

    await pool.query(`UPDATE runs SET phase = 'awaiting_cp1' WHERE id = $1`, [created.runId]);
    const approved = await call({ runId: created.runId, checkpoint: "CP1" }, human(authTime));
    expect(approved.result.structuredContent.error).toBeUndefined();
    expect(approved.result.structuredContent.status).toBe("active");
    const again = await call({ runId: created.runId, checkpoint: "CP1" }, human(authTime));
    expect(again.result.structuredContent.error).toBe("already_approved");
    const stored = await pool.query(
      `SELECT user_id, auth_time FROM approvals WHERE request_id = $1`,
      [created.requestId],
    );
    expect(stored.rows[0]?.user_id).toBe("human-fixture");
    const written = new Date(stored.rows[0]?.auth_time as string).getTime();
    expect(Math.abs(written - authTime * 1000)).toBeLessThan(1000);
    expect(Math.abs(written - Date.now())).toBeGreaterThan(20_000);
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("does not enqueue code before CP1, and simulation CP3 is not succeeded", async () => {
    await reset();
    const run = await store.createRun({ request: "no code yet" });
    expect((await tick()).enqueued).toBe(1);
    const names = await pool.query(`SELECT job_name FROM dispatch_outbox WHERE run_id = $1`, [
      run.runId,
    ]);
    expect(names.rows.map((row) => row.job_name)).toEqual(["plan"]);
    await waitUntil(async () => (await executions(run.runId)) === 1);
    await tick();
    const phase = await pool.query(`SELECT phase, status FROM runs WHERE id = $1`, [run.runId]);
    expect(phase.rows[0]).toMatchObject({ phase: "awaiting_cp1", status: "active" });
    const code = await pool.query(
      `SELECT count(*)::int AS n FROM dispatch_outbox WHERE run_id = $1 AND job_name = 'code'`,
      [run.runId],
    );
    expect(code.rows[0]?.n).toBe(0);

    await store.approve({
      runId: run.runId,
      checkpoint: "CP1",
      userId: "human-fixture",
      authTime: new Date().toISOString(),
    });
    await pool.query(`UPDATE runs SET phase = 'awaiting_cp2' WHERE id = $1`, [run.runId]);
    await store.approve({
      runId: run.runId,
      checkpoint: "CP2",
      userId: "human-fixture",
      authTime: new Date().toISOString(),
    });
    await pool.query(`UPDATE runs SET phase = 'awaiting_cp3' WHERE id = $1`, [run.runId]);
    const closed = await store.approve({
      runId: run.runId,
      checkpoint: "CP3",
      userId: "human-fixture",
      authTime: new Date().toISOString(),
    });
    expect(closed.status).toBe("needs_human");
    expect(closed.phaseReason).toBe("simulation_not_success");
    expect(closed.executionMode).toBe("simulation");
  });

  it("real success requires live mode, artifact, and same-commit verified gates", async () => {
    await reset();
    const run = await store.createRun({ request: "evidence" });
    const sha = "abc123def";
    await pool.query(
      `UPDATE runs SET phase = 'awaiting_cp3', execution_mode = 'live', commit_sha = $2 WHERE id = $1`,
      [run.runId, sha],
    );
    await pool.query(
      `INSERT INTO approvals (request_id, checkpoint, subject_hash, decision, user_id, auth_time)
       VALUES ($1, 'CP1', 'h1', 'approved', 'human-fixture', now()),
              ($1, 'CP2', 'h2', 'approved', 'human-fixture', now())`,
      [run.requestId],
    );
    const blocked = await store.approve({
      runId: run.runId,
      checkpoint: "CP3",
      userId: "human-fixture",
      authTime: new Date().toISOString(),
    });
    expect(blocked.status).toBe("needs_human");
    expect(blocked.phaseReason).toBe("evidence_missing");

    const again = await store.createRun({ request: "evidence ok" });
    await pool.query(
      `UPDATE runs SET phase = 'awaiting_cp3', execution_mode = 'live', commit_sha = $2 WHERE id = $1`,
      [again.runId, sha],
    );
    await pool.query(
      `INSERT INTO approvals (request_id, checkpoint, subject_hash, decision, user_id, auth_time)
       VALUES ($1, 'CP1', 'h1', 'approved', 'human-fixture', now()),
              ($1, 'CP2', 'h2', 'approved', 'human-fixture', now())`,
      [again.requestId],
    );
    await pool.query(
      `INSERT INTO run_evidence (run_id, commit_sha, kind, mode, uri) VALUES ($1, $2, 'artifact', 'verified', 'file://artifact')`,
      [again.runId, sha],
    );
    for (const gate of defaultLabOrgConfig().requiredChecks) {
      await pool.query(
        `INSERT INTO run_evidence (run_id, commit_sha, kind, gate_name, mode, passed)
         VALUES ($1, $2, 'gate', $3, 'verified', true)`,
        [again.runId, sha, gate],
      );
    }
    const done = await store.approve({
      runId: again.runId,
      checkpoint: "CP3",
      userId: "human-fixture",
      authTime: new Date().toISOString(),
    });
    expect(done.status).toBe("succeeded");
  });

  it("reserves budget atomically, recovers one enqueue, and does not rerun a deleted result", async () => {
    await reset();
    const run = await store.createRun({ request: "recover" });
    await tick(0);
    const stopped = await pool.query(`SELECT status, phase_reason FROM runs WHERE id = $1`, [
      run.runId,
    ]);
    expect(stopped.rows[0]).toMatchObject({
      status: "needs_human",
      phase_reason: "unbudgeted_estimate",
    });
    const none = await pool.query(
      `SELECT count(*)::int AS n FROM dispatch_outbox WHERE run_id = $1`,
      [run.runId],
    );
    expect(none.rows[0]?.n).toBe(0);

    await reset();
    const first = await store.createRun({ request: "a" });
    const second = await store.createRun({ request: "b" });
    const claimed = await repo.claimDue(2, 5, new Date());
    const config = await repo.loadConfig();
    const results = await Promise.all(
      claimed.map((snap) =>
        repo.commitDispatch(
          snap,
          {
            status: "active",
            phase: "planning",
            phaseReason: null,
            iteration: 0,
            deadlineAt: snap.deadlineAt,
          },
          {
            orgId: config.orgId,
            runId: snap.id,
            requestId: snap.requestId,
            role: "planner",
            jobName: "plan",
            iteration: 0,
            costUsd: 6,
            payload: {
              v: 1,
              name: "plan",
              role: "planner",
              runId: snap.id,
              requestId: snap.requestId,
              iteration: 0,
              requestText: null,
            },
          },
        ),
      ),
    );
    expect(results.map((row) => row.status).sort()).toEqual(["budget", "pending"]);
    const spent = await pool.query(
      `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd FROM credit_ledger WHERE org_id = $1::uuid`,
      [ORG],
    );
    expect(Number(spent.rows[0]?.usd)).toBeLessThanOrEqual(10);
    expect([first.runId, second.runId]).toHaveLength(2);

    await reset();
    const recover = await store.createRun({ request: "crash" });
    const [snap] = await repo.claimDue(1, 5, new Date());
    if (!snap) throw new Error("expected a claimed run");
    const org = await repo.loadConfig();
    const reserved = await repo.commitDispatch(
      snap,
      {
        status: "active",
        phase: "planning",
        phaseReason: null,
        iteration: 0,
        deadlineAt: snap.deadlineAt,
      },
      {
        orgId: org.orgId,
        runId: snap.id,
        requestId: snap.requestId,
        role: "planner",
        jobName: "plan",
        iteration: 0,
        costUsd: 6,
        payload: {
          v: 1,
          name: "plan",
          role: "planner",
          runId: snap.id,
          requestId: snap.requestId,
          iteration: 0,
          requestText: null,
        },
      },
    );
    expect(reserved.status).toBe("pending");
    const charged = await pool.query(
      `SELECT count(*)::int AS n FROM credit_ledger WHERE run_id = $1`,
      [recover.runId],
    );
    expect(charged.rows[0]?.n).toBe(1);
    await tick(6);
    const chargedAfter = await pool.query(
      `SELECT count(*)::int AS n, COALESCE(SUM(cost_usd), 0)::float8 AS usd FROM credit_ledger WHERE run_id = $1`,
      [recover.runId],
    );
    expect(chargedAfter.rows[0]?.n).toBe(1);
    expect(Number(chargedAfter.rows[0]?.usd)).toBe(6);
    const key = agentJobId({ name: "plan", runId: recover.runId, iteration: 0 });
    await waitUntil(async () => (await executions(recover.runId)) === 1);
    const done = await queue.getJob(key);
    await done?.remove();
    await tick(6);
    expect(await executions(recover.runId)).toBe(1);
    const phase = await pool.query(`SELECT phase FROM runs WHERE id = $1`, [recover.runId]);
    expect(phase.rows[0]?.phase).toBe("awaiting_cp1");
  });

  it("enforces the fix-loop cap and stops timed-out work", async () => {
    await reset();
    const run = await store.createRun({ request: "fix" });
    await pool.query(`UPDATE runs SET phase = 'gates', iteration = 1 WHERE id = $1`, [run.runId]);
    const escalated = await tick(1, () => [{ name: "unit", passed: false }]).then(async () => {
      const { rows } = await pool.query(`SELECT status FROM runs WHERE id = $1`, [run.runId]);
      return rows[0] as { status: string };
    });
    expect(escalated.status).toBe("escalated");
    const fixes = await pool.query(
      `SELECT count(*)::int AS n FROM dispatch_outbox WHERE run_id = $1 AND job_name = 'fix'`,
      [run.runId],
    );
    expect(fixes.rows[0]?.n).toBe(0);

    const timed = await store.createRun({ request: "clock" });
    await tick(1);
    await pool.query(
      `UPDATE runs SET deadline_at = now() - interval '1 minute', started_at = now() - interval '2 hours' WHERE id = $1`,
      [timed.runId],
    );
    await tick(1);
    const after = await pool.query(`SELECT status, phase_reason FROM runs WHERE id = $1`, [
      timed.runId,
    ]);
    expect(after.rows[0]?.status).toBe("needs_human");
    expect(["wall_clock", "needs_reconciliation"]).toContain(after.rows[0]?.phase_reason);
    const open = await pool.query(
      `SELECT count(*)::int AS n FROM dispatch_outbox WHERE run_id = $1 AND state IN ('pending','enqueued')`,
      [timed.runId],
    );
    expect(open.rows[0]?.n).toBe(0);
    const before = await executions(timed.runId);
    await tick(1);
    expect(await executions(timed.runId)).toBe(before);
    const still = await pool.query(`SELECT status, phase FROM runs WHERE id = $1`, [timed.runId]);
    expect(still.rows[0]?.status).toBe("needs_human");
    expect(still.rows[0]?.phase).not.toBe("coding");
  });

  it("does not execute a dispatch whose deadline already passed", async () => {
    await reset();
    const run = await store.createRun({ request: "late" });
    const [snap] = await repo.claimDue(1, 5, new Date());
    if (!snap) throw new Error("expected a claimed run");
    const org = await repo.loadConfig();
    await repo.commitDispatch(
      snap,
      {
        status: "active",
        phase: "planning",
        phaseReason: null,
        iteration: 0,
        deadlineAt: snap.deadlineAt,
      },
      {
        orgId: org.orgId,
        runId: snap.id,
        requestId: snap.requestId,
        role: "planner",
        jobName: "plan",
        iteration: 0,
        costUsd: 1,
        payload: {
          v: 1,
          name: "plan",
          role: "planner",
          runId: snap.id,
          requestId: snap.requestId,
          iteration: 0,
          requestText: null,
        },
      },
    );
    await pool.query(`UPDATE runs SET deadline_at = now() - interval '1 minute' WHERE id = $1`, [
      run.runId,
    ]);
    await tick(1);
    expect(await executions(run.runId)).toBe(0);
    const direct = await completeDispatchOnce(pool, "plan", {
      v: 1,
      name: "plan",
      role: "planner",
      runId: run.runId,
      requestId: run.requestId,
      iteration: 0,
      requestText: null,
    });
    expect(direct.executed).toBe(false);
    expect(direct.reason).toBe("not_runnable");
    expect(await executions(run.runId)).toBe(0);
  });

  it("rejects CP3 until every org_config required check has same-commit evidence", async () => {
    await reset();
    await pool.query(
      `UPDATE org_config SET required_checks = ARRAY['unit','extra_lab_gate']::text[] WHERE org_id = $1::uuid`,
      [ORG],
    );
    const sha = "sha-extra";
    const blocked = await store.createRun({ request: "missing extra gate" });
    await pool.query(
      `UPDATE runs SET phase = 'awaiting_cp3', execution_mode = 'live', commit_sha = $2 WHERE id = $1`,
      [blocked.runId, sha],
    );
    await pool.query(
      `INSERT INTO approvals (request_id, checkpoint, subject_hash, decision, user_id, auth_time)
       VALUES ($1, 'CP1', 'h1', 'approved', 'human-fixture', now()),
              ($1, 'CP2', 'h2', 'approved', 'human-fixture', now())`,
      [blocked.requestId],
    );
    await pool.query(
      `INSERT INTO run_evidence (run_id, commit_sha, kind, mode, uri)
       VALUES ($1, $2, 'artifact', 'verified', 'file://artifact')`,
      [blocked.runId, sha],
    );
    await pool.query(
      `INSERT INTO run_evidence (run_id, commit_sha, kind, gate_name, mode, passed)
       VALUES ($1, $2, 'gate', 'unit', 'verified', true)`,
      [blocked.runId, sha],
    );
    const rejected = await store.approve({
      runId: blocked.runId,
      checkpoint: "CP3",
      userId: "human-fixture",
      authTime: new Date().toISOString(),
    });
    expect(rejected.status).toBe("needs_human");
    expect(rejected.phaseReason).toBe("evidence_missing");

    const ready = await store.createRun({ request: "extra gate present" });
    await pool.query(
      `UPDATE runs SET phase = 'awaiting_cp3', execution_mode = 'live', commit_sha = $2 WHERE id = $1`,
      [ready.runId, sha],
    );
    await pool.query(
      `INSERT INTO approvals (request_id, checkpoint, subject_hash, decision, user_id, auth_time)
       VALUES ($1, 'CP1', 'h1', 'approved', 'human-fixture', now()),
              ($1, 'CP2', 'h2', 'approved', 'human-fixture', now())`,
      [ready.requestId],
    );
    await pool.query(
      `INSERT INTO run_evidence (run_id, commit_sha, kind, mode, uri)
       VALUES ($1, $2, 'artifact', 'verified', 'file://artifact')`,
      [ready.runId, sha],
    );
    for (const gate of ["unit", "extra_lab_gate"]) {
      await pool.query(
        `INSERT INTO run_evidence (run_id, commit_sha, kind, gate_name, mode, passed)
         VALUES ($1, $2, 'gate', $3, 'verified', true)`,
        [ready.runId, sha, gate],
      );
    }
    const accepted = await store.approve({
      runId: ready.runId,
      checkpoint: "CP3",
      userId: "human-fixture",
      authTime: new Date().toISOString(),
    });
    expect(accepted.status).toBe("succeeded");
  });

  it("surfaces crash-after-running as needs_reconciliation and does not execute again", async () => {
    await reset();
    const run = await store.createRun({ request: "crashed" });
    const [snap] = await repo.claimDue(1, 5, new Date());
    if (!snap) throw new Error("expected a claimed run");
    const org = await repo.loadConfig();
    await repo.commitDispatch(
      snap,
      {
        status: "active",
        phase: "planning",
        phaseReason: null,
        iteration: 0,
        deadlineAt: snap.deadlineAt,
      },
      {
        orgId: org.orgId,
        runId: snap.id,
        requestId: snap.requestId,
        role: "planner",
        jobName: "plan",
        iteration: 0,
        costUsd: 1,
        payload: {
          v: 1,
          name: "plan",
          role: "planner",
          runId: snap.id,
          requestId: snap.requestId,
          iteration: 0,
          requestText: null,
        },
      },
    );
    await pool.query(
      `UPDATE dispatch_outbox
       SET state = 'running', executions = 1, heartbeat_at = now() - interval '2 hours'
       WHERE run_id = $1`,
      [run.runId],
    );
    await tick(1);
    const stored = await pool.query(`SELECT status, phase_reason FROM runs WHERE id = $1`, [
      run.runId,
    ]);
    expect(stored.rows[0]).toMatchObject({
      status: "needs_human",
      phase_reason: "needs_reconciliation",
    });
    const box = await pool.query(
      `SELECT state, reconciliation, executions FROM dispatch_outbox WHERE run_id = $1`,
      [run.runId],
    );
    expect(box.rows[0]).toMatchObject({
      state: "needs_reconciliation",
      reconciliation: "crash_after_running",
      executions: 1,
    });
    await tick(1);
    expect(await executions(run.runId)).toBe(1);

    const inflight = await store.createRun({ request: "cancel mid flight" });
    await pool.query(`UPDATE runs SET phase = 'planning' WHERE id = $1`, [inflight.runId]);
    const key = agentJobId({ name: "plan", runId: inflight.runId, iteration: 0 });
    await pool.query(
      `INSERT INTO dispatch_outbox
         (idempotency_key, org_id, run_id, request_id, job_name, role, iteration, payload, cost_usd, state, executions, heartbeat_at)
       VALUES ($1, $2::uuid, $3, $4, 'plan', 'planner', 0, '{}'::jsonb, 1, 'running', 1, now())`,
      [key, ORG, inflight.runId, inflight.requestId],
    );
    await pool.query(`UPDATE runs SET deadline_at = now() - interval '1 minute' WHERE id = $1`, [
      inflight.runId,
    ]);
    const finished = await finishDispatch(pool, key);
    expect(finished).toBe("needs_reconciliation");
    const after = await pool.query(
      `SELECT state, reconciliation FROM dispatch_outbox WHERE idempotency_key = $1`,
      [key],
    );
    expect(after.rows[0]).toMatchObject({
      state: "needs_reconciliation",
      reconciliation: "external_effect_unknown",
    });
  });

  it("keeps needs_reconciliation when the handler starts, the deadline passes, halt runs, then finish runs", async () => {
    await reset();
    await worker.pause();
    try {
      const run = await store.createRun({ request: "halt after handler" });
      const [snap] = await repo.claimDue(1, 5, new Date());
      if (!snap) throw new Error("expected a claimed run");
      const org = await repo.loadConfig();
      const payload = {
        v: 1 as const,
        name: "plan" as const,
        role: "planner" as const,
        runId: snap.id,
        requestId: snap.requestId,
        iteration: 0,
        requestText: null,
      };
      const committed = await repo.commitDispatch(
        snap,
        {
          status: "active",
          phase: "planning",
          phaseReason: null,
          iteration: 0,
          deadlineAt: snap.deadlineAt,
        },
        {
          orgId: org.orgId,
          runId: snap.id,
          requestId: snap.requestId,
          role: "planner",
          jobName: "plan",
          iteration: 0,
          costUsd: 1,
          payload,
        },
      );
      if (committed.status !== "pending")
        throw new Error(`expected pending, got ${committed.status}`);
      await jobs.enqueue(payload);
      await repo.markEnqueued(committed.idempotencyKey);

      const done = await completeDispatchOnce(pool, "plan", payload, {
        afterHandler: async () => {
          await pool.query(
            `UPDATE runs SET deadline_at = now() - interval '1 second' WHERE id = $1`,
            [run.runId],
          );
          const fresh = await loadSnap(run.runId);
          const halted = await repo.haltRun(fresh, {
            status: "needs_human",
            phase: "planning",
            phaseReason: "wall_clock",
            iteration: fresh.iteration,
            deadlineAt: fresh.deadlineAt,
          });
          expect(halted).toBe("ok");
        },
      });
      expect(done).toMatchObject({
        executed: true,
        reason: "needs_reconciliation",
        result: { externalEffect: "unknown" },
      });
      const box = await outbox(committed.idempotencyKey);
      expect(box).toMatchObject({
        state: "needs_reconciliation",
        reconciliation: "halted_while_running",
        executions: 1,
      });
      const stored = await pool.query(`SELECT status, phase_reason FROM runs WHERE id = $1`, [
        run.runId,
      ]);
      expect(stored.rows[0]).toMatchObject({ status: "needs_human", phase_reason: "wall_clock" });

      expect(await finishDispatch(pool, committed.idempotencyKey)).toBe("needs_reconciliation");
      expect(await repo.markDispatchCompleted(committed.idempotencyKey)).toEqual({
        executed: false,
      });
      await pool.query(
        `UPDATE dispatch_outbox SET heartbeat_at = now() - interval '2 hours' WHERE idempotency_key = $1`,
        [committed.idempotencyKey],
      );
      expect(
        await repo.reconcileStaleRunning(committed.idempotencyKey, await loadSnap(run.runId), 30),
      ).toBe(false);
      expect(await outbox(committed.idempotencyKey)).toMatchObject({
        state: "needs_reconciliation",
        reconciliation: "halted_while_running",
        executions: 1,
      });
      expect(await completeDispatchOnce(pool, "plan", payload)).toMatchObject({
        executed: false,
        reason: "not_runnable",
      });
      expect((await tick(1)).enqueued).toBe(0);
      expect(await executions(run.runId)).toBe(1);
    } finally {
      const queued = await queue.getJobs(["waiting", "active", "delayed", "paused"]);
      await Promise.all(queued.map((job) => job.remove().catch(() => undefined)));
      await worker.resume();
    }
  });

  it("does not let a later halt replace a cause finish already stored", async () => {
    await reset();
    const seeded = await seedRunning("finish then halt");
    await pool.query(`UPDATE runs SET deadline_at = now() - interval '1 second' WHERE id = $1`, [
      seeded.run.runId,
    ]);
    expect(await finishDispatch(pool, seeded.key)).toBe("needs_reconciliation");
    const halted = await repo.haltRun(await loadSnap(seeded.run.runId), {
      status: "needs_human",
      phase: "planning",
      phaseReason: "wall_clock",
      iteration: 0,
      deadlineAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(halted).toBe("conflict");
    expect(await outbox(seeded.key)).toMatchObject({
      state: "needs_reconciliation",
      reconciliation: "external_effect_unknown",
      executions: 1,
    });
    await pool.query(`UPDATE runs SET status = 'active', phase_reason = NULL WHERE id = $1`, [
      seeded.run.runId,
    ]);
    const fresh = await loadSnap(seeded.run.runId);
    expect(
      await repo.haltRun(fresh, {
        status: "needs_human",
        phase: "planning",
        phaseReason: "wall_clock",
        iteration: fresh.iteration,
        deadlineAt: fresh.deadlineAt,
      }),
    ).toBe("ok");
    expect(await outbox(seeded.key)).toMatchObject({
      state: "needs_reconciliation",
      reconciliation: "external_effect_unknown",
      executions: 1,
    });
    expect(await completeDispatchOnce(pool, "plan", seeded.payload)).toMatchObject({
      executed: false,
      reason: "not_runnable",
    });
  });

  it("covers concurrent halt and finish without completing or rerunning", async () => {
    await reset();
    for (let i = 0; i < 4; i += 1) {
      const seeded = await seedRunning(`race ${i}`);
      await pool.query(`UPDATE runs SET deadline_at = now() - interval '1 second' WHERE id = $1`, [
        seeded.run.runId,
      ]);
      const fresh = await loadSnap(seeded.run.runId);
      const [halted, finished] = await Promise.all([
        repo.haltRun(fresh, {
          status: "needs_human",
          phase: "planning",
          phaseReason: "wall_clock",
          iteration: fresh.iteration,
          deadlineAt: fresh.deadlineAt,
        }),
        finishDispatch(pool, seeded.key),
      ]);
      expect(["ok", "conflict"]).toContain(halted);
      expect(finished).toBe("needs_reconciliation");
      const box = await outbox(seeded.key);
      expect(box.state).toBe("needs_reconciliation");
      expect(["halted_while_running", "external_effect_unknown"]).toContain(box.reconciliation);
      expect(box.executions).toBe(1);
      expect(await finishDispatch(pool, seeded.key)).toBe("needs_reconciliation");
      expect(await repo.markDispatchCompleted(seeded.key)).toEqual({ executed: false });
      expect(
        await repo.reconcileStaleRunning(seeded.key, await loadSnap(seeded.run.runId), 0),
      ).toBe(false);
      expect(await outbox(seeded.key)).toMatchObject({
        state: "needs_reconciliation",
        reconciliation: box.reconciliation,
        executions: 1,
      });
      expect(await completeDispatchOnce(pool, "plan", seeded.payload)).toMatchObject({
        executed: false,
        reason: "not_runnable",
      });
    }
  });

  it("reconciles a cancelled in-flight dispatch and still cancels one that never started", async () => {
    await reset();
    const seeded = await seedRunning("cancel in flight");
    const fresh = await loadSnap(seeded.run.runId);
    expect(
      await repo.haltRun(fresh, {
        status: "cancelled",
        phase: "planning",
        phaseReason: "cancelled",
        iteration: fresh.iteration,
        deadlineAt: fresh.deadlineAt,
      }),
    ).toBe("ok");
    expect(await finishDispatch(pool, seeded.key)).toBe("needs_reconciliation");
    expect(await outbox(seeded.key)).toMatchObject({
      state: "needs_reconciliation",
      reconciliation: "halted_while_running",
      executions: 1,
    });
    const runRow = await pool.query(`SELECT status, phase_reason FROM runs WHERE id = $1`, [
      seeded.run.runId,
    ]);
    expect(runRow.rows[0]).toMatchObject({ status: "cancelled", phase_reason: "cancelled" });
    await pool.query(
      `UPDATE dispatch_outbox SET heartbeat_at = now() - interval '2 hours' WHERE idempotency_key = $1`,
      [seeded.key],
    );
    expect(await repo.reconcileStaleRunning(seeded.key, await loadSnap(seeded.run.runId), 1)).toBe(
      false,
    );
    expect(await repo.markDispatchCompleted(seeded.key)).toEqual({ executed: false });
    expect((await outbox(seeded.key)).reconciliation).toBe("halted_while_running");
    expect((await completeDispatchOnce(pool, "plan", seeded.payload)).executed).toBe(false);

    const legacy = await seedRunning("legacy cancelled while running");
    await pool.query(`UPDATE dispatch_outbox SET state = 'cancelled' WHERE idempotency_key = $1`, [
      legacy.key,
    ]);
    await pool.query(
      `UPDATE runs SET status = 'needs_human', phase_reason = 'wall_clock' WHERE id = $1`,
      [legacy.run.runId],
    );
    expect(await finishDispatch(pool, legacy.key)).toBe("needs_reconciliation");
    expect(await outbox(legacy.key)).toMatchObject({
      state: "needs_reconciliation",
      reconciliation: "external_effect_unknown",
      executions: 1,
    });

    const waiting = await store.createRun({ request: "not started" });
    await pool.query(`UPDATE runs SET phase = 'planning' WHERE id = $1`, [waiting.runId]);
    const pendingKey = agentJobId({ name: "plan", runId: waiting.runId, iteration: 0 });
    await pool.query(
      `INSERT INTO dispatch_outbox
         (idempotency_key, org_id, run_id, request_id, job_name, role, iteration, payload, cost_usd, state, executions)
       VALUES ($1, $2::uuid, $3, $4, 'plan', 'planner', 0, '{}'::jsonb, 1, 'pending', 0)`,
      [pendingKey, ORG, waiting.runId, waiting.requestId],
    );
    const pendingSnap = await loadSnap(waiting.runId);
    expect(
      await repo.haltRun(pendingSnap, {
        status: "needs_human",
        phase: "planning",
        phaseReason: "wall_clock",
        iteration: pendingSnap.iteration,
        deadlineAt: pendingSnap.deadlineAt,
      }),
    ).toBe("ok");
    expect(await finishDispatch(pool, pendingKey)).not.toBe("completed");
    const pending = await pool.query(
      `SELECT state, executions, reconciliation FROM dispatch_outbox WHERE idempotency_key = $1`,
      [pendingKey],
    );
    expect(pending.rows[0]).toMatchObject({
      state: "cancelled",
      executions: 0,
      reconciliation: null,
    });
    expect(await executions(waiting.runId)).toBe(0);
  });
});
