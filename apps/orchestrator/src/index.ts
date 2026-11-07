import { createCursorCloudClient, readCursorExecutorConfig } from "@gb/cursor-cloud";
import { createApp, type LoopStatus } from "./app.js";
import { createBullDispatcher } from "./bull.js";
import { type JobDispatcher, MemoryJobDispatcher } from "./dispatcher.js";
import { readEnv } from "./env.js";
import { runTick } from "./loop.js";
import { createPostgresRepository } from "./postgres.js";
import type { RunRepository } from "./repo.js";

const env = readEnv();
const cursorConfig = readCursorExecutorConfig();
const cursorClient =
  cursorConfig.mode === "ready"
    ? createCursorCloudClient({ apiKey: cursorConfig.apiKey, apiBase: cursorConfig.apiBase })
    : null;
const status: LoopStatus = {
  queue: "off",
  database: false,
  redis: false,
  pollMs: env.pollMs,
  lastTickAt: null,
  lastError: null,
};

const app = createApp(status);
const server = app.listen(env.port, () => {
  console.log(
    JSON.stringify({
      msg: "orchestrator listening",
      port: env.port,
      mode: "lifecycle",
      database: Boolean(env.databaseUrl),
      redis: Boolean(env.redisUrl),
    }),
  );
});

let repo: RunRepository | null = null;
let jobs: JobDispatcher | null = null;
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;
let ticking = false;
let stopping = false;

function scheduleTick(): void {
  if (stopping || ticking || !repo || !jobs) return;
  const currentRepo = repo;
  const currentJobs = jobs;
  ticking = true;
  inFlight = runTick({
    repo: currentRepo,
    jobs: currentJobs,
    now: new Date(),
    leaseSeconds: env.leaseSeconds,
    batchSize: env.batchSize,
    estimateUsd: env.estimateUsd,
    staleSeconds: env.staleSeconds,
    failGates: env.failGates,
    cursor: cursorClient,
  })
    .then((stats) => {
      status.lastTickAt = new Date().toISOString();
      status.lastError = null;
      if (stats.claimed > 0) {
        console.log(JSON.stringify({ msg: "orchestrator tick", ...stats }));
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      status.lastError = message;
      console.error(JSON.stringify({ msg: "orchestrator tick failed", error: message }));
    })
    .finally(() => {
      ticking = false;
      inFlight = null;
    });
}

if (env.databaseUrl) {
  try {
    repo = await createPostgresRepository(env.databaseUrl);
    jobs = env.redisUrl ? createBullDispatcher(env.redisUrl) : new MemoryJobDispatcher(true);
    status.database = true;
    status.redis = Boolean(env.redisUrl);
    status.queue = env.redisUrl ? "bullmq" : "inline";
    if (!env.redisUrl) {
      console.log(
        JSON.stringify({
          msg: "REDIS_URL unset; agent jobs complete inline and are not handed to the worker",
        }),
      );
    }
    console.log(
      JSON.stringify({
        msg: "orchestrator loop started",
        pollMs: env.pollMs,
        leaseSeconds: env.leaseSeconds,
        batch: env.batchSize,
        queue: status.queue,
        estimateUsd: env.estimateUsd,
        staleSeconds: env.staleSeconds,
      }),
    );
    scheduleTick();
    timer = setInterval(scheduleTick, env.pollMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    status.lastError = message;
    console.error(JSON.stringify({ msg: "orchestrator loop not started", error: message }));
  }
} else {
  console.log(JSON.stringify({ msg: "DATABASE_URL unset; orchestrator loop idle" }));
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ msg: "orchestrator shutting down", signal }));
  if (timer) clearInterval(timer);
  if (inFlight) await inFlight;
  await jobs?.close();
  await repo?.close();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
