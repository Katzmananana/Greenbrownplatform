import { Worker } from "bullmq";
import express from "express";

const port = Number(process.env.PORT ?? 3003);
const redisUrl = process.env.REDIS_URL;

function redisConnection(urlStr: string) {
  const u = new URL(urlStr);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    username: u.username ? decodeURIComponent(u.username) : undefined,
  };
}

let worker: Worker | undefined;
if (redisUrl) {
  worker = new Worker(
    "jobs",
    async (job) => {
      console.log(JSON.stringify({ msg: "worker stub handled job", name: job.name, id: job.id }));
      return { ok: true, stub: true, name: job.name };
    },
    { connection: redisConnection(redisUrl) },
  );
  worker.on("error", (err) => {
    console.error(JSON.stringify({ msg: "worker error", error: err.message }));
  });
} else {
  console.log(JSON.stringify({ msg: "worker stub: REDIS_URL unset, HTTP health only" }));
}

const app = express();
app.disable("x-powered-by");
const health = (_req: express.Request, res: express.Response): void => {
  res.status(200).json({
    status: "ok",
    service: "worker",
    platform: "akshi-green-brown",
    redis: Boolean(redisUrl),
    time: new Date().toISOString(),
  });
};
app.get("/health", health);
app.get("/healthz", health);
app.get("/readyz", health);

const server = app.listen(port, () => {
  console.log(JSON.stringify({ msg: "worker listening", port, redis: Boolean(redisUrl) }));
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
