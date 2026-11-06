import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { CreditGuard, defaultLabOrgConfig, InMemoryCreditLedger } from "@gb/credits";
import { createApp } from "../src/app.js";

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe("gateway functional", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((err) => (err ? reject(err) : resolve()));
    });
    server = undefined;
  });

  it("GET /health returns 200 JSON", async () => {
    const started = await listen(createApp());
    server = started.server;
    const res = await fetch(`${started.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("gateway");
  });

  it("POST /mcp stub responds and the credit hook allows zero-cost calls", async () => {
    const started = await listen(createApp());
    server = started.server;
    const res = await fetch(`${started.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { stub: boolean } };
    expect(body.result.stub).toBe(true);
  });

  it("credit hard-stop middleware blocks an over-budget LLM preflight", async () => {
    const guard = new CreditGuard(
      defaultLabOrgConfig({
        maxCostUsd: 1,
        maxCostUsdPerRun: 1,
        perRoleBudgetUsd: { coder: 1, planner: 1, reviewer: 1, fixer: 1, reporter: 1 },
      }),
      new InMemoryCreditLedger(),
    );
    const started = await listen(createApp({ creditGuard: guard }));
    server = started.server;
    const res = await fetch(`${started.url}/internal/credits/preflight`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gb-estimate-cost-usd": "2",
        "x-gb-role": "coder",
        "x-gb-run-id": "run-over",
      },
      body: "{}",
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; escalation: string };
    expect(body.error).toBe("credit_hard_stop");
    expect(body.escalation).toBe("NEEDS_HUMAN");
  });
});
