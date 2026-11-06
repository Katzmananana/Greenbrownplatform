import express, { type Express } from "express";
import { CreditGuard, defaultLabOrgConfig, InMemoryCreditLedger } from "@gb/credits";
import { creditHardStopMiddleware } from "./middleware/credits.js";

export interface GatewayOptions {
  creditGuard?: CreditGuard;
  service?: string;
}

export function createApp(options: GatewayOptions = {}): Express {
  const creditGuard =
    options.creditGuard ?? new CreditGuard(defaultLabOrgConfig(), new InMemoryCreditLedger());
  const service = options.service ?? "gateway";
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const health = (_req: express.Request, res: express.Response): void => {
    res.status(200).json({
      status: "ok",
      service,
      platform: "akshi-green-brown",
      time: new Date().toISOString(),
    });
  };

  app.get("/health", health);
  app.get("/healthz", health);
  app.get("/readyz", health);

  app.post("/mcp", creditHardStopMiddleware(creditGuard), (req, res) => {
    const id = req.body && typeof req.body === "object" ? (req.body as { id?: unknown }).id : null;
    res.status(200).json({
      jsonrpc: "2.0",
      id: id ?? null,
      result: {
        stub: true,
        message: "MCP endpoint stub — tools will be registered in a later milestone",
        tools: [],
      },
    });
  });

  app.post("/internal/credits/preflight", creditHardStopMiddleware(creditGuard), (_req, res) => {
    res.status(200).json({ ok: true, preflight: true });
  });

  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = err instanceof Error ? err.message : "internal_error";
      res.status(500).json({ error: "internal_error", message });
    },
  );

  return app;
}
