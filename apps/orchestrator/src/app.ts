import express, { type Express } from "express";
import { defaultLabOrgConfig } from "@gb/credits";
import { decideFixLoop } from "@gb/gates";

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const health = (_req: express.Request, res: express.Response): void => {
    res.status(200).json({
      status: "ok",
      service: "orchestrator",
      platform: "akshi-green-brown",
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
      stub: true,
      message:
        decision.action === "retry"
          ? "fix-loop placeholder: enqueue another VERIFYING iteration"
          : "fix-loop cap reached — ESCALATED / NEEDS_HUMAN",
    });
  });

  return app;
}
