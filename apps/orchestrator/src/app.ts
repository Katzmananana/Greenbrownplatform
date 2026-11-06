import express, { type Express } from "express";
import { defaultLabOrgConfig } from "@gb/credits";
import { decideFixLoop } from "@gb/gates";

export interface LoopStatus {
  /** `off` when DATABASE_URL is unset; `inline` when Redis is unset; `bullmq` when both are set. */
  queue: "off" | "inline" | "bullmq";
  database: boolean;
  redis: boolean;
  pollMs: number;
  lastTickAt: string | null;
  lastError: string | null;
}

export function createApp(status: LoopStatus): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const health = (_req: express.Request, res: express.Response): void => {
    res.status(200).json({
      status: "ok",
      service: "orchestrator",
      platform: "akshi-green-brown",
      mode: "lifecycle",
      queue: status.queue,
      database: status.database,
      redis: status.redis,
      pollMs: status.pollMs,
      lastTickAt: status.lastTickAt,
      lastError: status.lastError,
      time: new Date().toISOString(),
    });
  };
  app.get("/health", health);
  app.get("/healthz", health);
  app.get("/readyz", health);

  app.post("/internal/fix-loop/next", (req, res) => {
    const config = defaultLabOrgConfig();
    const iteration = Number((req.body as { iteration?: unknown })?.iteration ?? 0);
    if (!Number.isFinite(iteration) || iteration < 0) {
      res.status(400).json({ error: "invalid_iteration" });
      return;
    }
    const decision = decideFixLoop(config, iteration);
    res.status(200).json({
      ...decision,
      message:
        decision.action === "retry"
          ? "lifecycle loop enqueues a fixer job when a blocking gate fails"
          : "fix-loop cap reached — run status escalated",
    });
  });

  return app;
}
