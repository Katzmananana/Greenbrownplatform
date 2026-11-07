import { Worker } from "bullmq";
import express from "express";
import { JOB_QUEUE_NAME, bullmqConnectionFromUrl, type AgentJobPayload } from "@gb/shared";
import { executeQueuedJob } from "./complete.js";

const port = Number(process.env.PORT ?? 3003);
const redisUrl = process.env.REDIS_URL?.trim() || undefined;

const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
let dispatchDb: { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> } | undefined;
if (databaseUrl) {
  const moduleName = "pg";
  const mod = (await import(moduleName)) as {
    default?: {
      Pool?: new (config: { connectionString: string; max?: number }) => {
        query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
      };
    };
    Pool?: new (config: { connectionString: string; max?: number }) => {
      query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
    };
  };
  const Pool = mod.default?.Pool ?? mod.Pool;
  if (Pool) dispatchDb = new Pool({ connectionString: databaseUrl, max: 2 });
}

let worker: Worker<AgentJobPayload> | undefined;
if (redisUrl && !dispatchDb) {
  console.error(
    JSON.stringify({
      msg: "worker fail-closed: REDIS_URL is set but DATABASE_URL is missing; jobs are not executed",
      queue: JOB_QUEUE_NAME,
    }),
  );
} else if (redisUrl && dispatchDb) {
  const db = dispatchDb;
  worker = new Worker<AgentJobPayload>(
    JOB_QUEUE_NAME,
    async (job) => {
      const done = await executeQueuedJob(db, job.name, job.data);
      if (!done.executed) {
        throw new Error(done.reason ?? "not_executed");
      }
      return done.result;
    },
    { connection: bullmqConnectionFromUrl(redisUrl) },
  );
  worker.on("error", (err) => {
    console.error(JSON.stringify({ msg: "worker error", error: err.message }));
  });
} else {
  console.log(
    JSON.stringify({ msg: "REDIS_URL unset; worker HTTP health only", queue: JOB_QUEUE_NAME }),
  );
}

const app = express();
app.disable("x-powered-by");
const health = (_req: express.Request, res: express.Response): void => {
  res.status(200).json({
    status: "ok",
    service: "worker",
    platform: "akshi-green-brown",
    redis: Boolean(redisUrl),
    durable: Boolean(dispatchDb),
    queue: JOB_QUEUE_NAME,
    time: new Date().toISOString(),
  });
};
app.get("/health", health);
app.get("/healthz", health);
app.get("/readyz", health);

const server = app.listen(port, () => {
  console.log(
    JSON.stringify({
      msg: "worker listening",
      port,
      redis: Boolean(redisUrl),
      queue: JOB_QUEUE_NAME,
    }),
  );
});

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ msg: "worker shutting down", signal }));
  await worker?.close();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
