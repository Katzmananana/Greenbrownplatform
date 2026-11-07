import express, { type Express } from "express";
import { CreditGuard, defaultLabOrgConfig, InMemoryCreditLedger } from "@gb/credits";
import { type McpAuthConfig, mcpAuthMiddleware } from "./mcp/auth.js";
import { type HumanAuthConfig, readHumanAuthConfig } from "./mcp/human-auth.js";
import { JSONRPC_ERRORS, handleJsonRpc, rpcError } from "./mcp/server.js";
import { creditHardStopMiddleware } from "./middleware/credits.js";
import { InMemoryRunStore } from "./store/memory.js";
import type { RunStore } from "./store/types.js";

export interface GatewayOptions {
  creditGuard?: CreditGuard;
  service?: string;
  /** Defaults to an in-memory store; index.ts picks Postgres from DATABASE_URL. */
  runStore?: RunStore;
  /** Defaults to { token: GB_MCP_TOKEN, nodeEnv: NODE_ENV }. */
  mcpAuth?: McpAuthConfig;
  /** Human approval JWT. Unset secret fails approve closed. */
  humanAuth?: HumanAuthConfig;
}

export function createApp(options: GatewayOptions = {}): Express {
  const creditGuard =
    options.creditGuard ?? new CreditGuard(defaultLabOrgConfig(), new InMemoryCreditLedger());
  const service = options.service ?? "gateway";
  const runStore = options.runStore ?? new InMemoryRunStore();
  const mcpAuth = options.mcpAuth ?? {
    token: process.env.GB_MCP_TOKEN,
    nodeEnv: process.env.NODE_ENV,
  };
  const humanAuth = options.humanAuth ?? {
    ...readHumanAuthConfig(),
    agentCredential: mcpAuth.token,
  };
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const health = (_req: express.Request, res: express.Response): void => {
    res.status(200).json({
      status: "ok",
      service,
      platform: "akshi-green-brown",
      runStore: runStore.kind,
      time: new Date().toISOString(),
    });
  };

  app.get("/health", health);
  app.get("/healthz", health);
  app.get("/readyz", health);

  // MCP over HTTP (JSON responses; no SSE stream). Auth first, then the credit
  // hard-stop hook, then JSON-RPC dispatch.
  app.post(
    "/mcp",
    mcpAuthMiddleware(mcpAuth),
    creditHardStopMiddleware(creditGuard),
    async (req, res, next) => {
      try {
        const response = await handleJsonRpc(req.body, {
          store: runStore,
          principal: String(res.locals.mcpPrincipal ?? "anonymous"),
          ip: req.ip ?? null,
          humanAuthorization: req.header("x-gb-human-authorization") ?? null,
          humanAuth,
        });
        if (response === null) {
          res.status(202).end();
          return;
        }
        res.status(200).json(response);
      } catch (err) {
        next(err);
      }
    },
  );

  app.get("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "method_not_allowed", message: "use POST /mcp (JSON-RPC)" });
  });

  app.post("/internal/credits/preflight", creditHardStopMiddleware(creditGuard), (_req, res) => {
    res.status(200).json({ ok: true, preflight: true });
  });

  app.use(
    (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const parseFailed =
        typeof err === "object" &&
        err !== null &&
        (err as { type?: unknown }).type === "entity.parse.failed";
      if (parseFailed && req.path === "/mcp") {
        res.status(400).json(rpcError(null, JSONRPC_ERRORS.parseError, "parse error"));
        return;
      }
      const message = err instanceof Error ? err.message : "internal_error";
      res.status(500).json({ error: "internal_error", message });
    },
  );

  return app;
}
