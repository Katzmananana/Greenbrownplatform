import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type GatewayOptions } from "../src/app.js";
import { signHumanJwt } from "../src/mcp/human-auth.js";
import { InMemoryRunStore } from "../src/store/memory.js";

const TOKEN = "lab-test-token";
const FIXTURE_KEY = "hmac-fixture-key";

function humanHeader(): string {
  const authTime = Math.floor(Date.now() / 1000);
  return `Bearer ${signHumanJwt(FIXTURE_KEY, { sub: "human-fixture", authTime, exp: authTime + 600 })}`;
}

let server: Server | undefined;

async function start(options: GatewayOptions = {}): Promise<string> {
  const app = createApp({ mcpAuth: { token: TOKEN, nodeEnv: "test" }, ...options });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => (err ? reject(err) : resolve()));
  });
  server = undefined;
});

let nextId = 1;

async function rpc(
  url: string,
  method: string,
  params?: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function tool(
  url: string,
  name: string,
  args: unknown,
  headers: Record<string, string> = {},
): Promise<any> {
  const { status, body } = await rpc(
    url,
    "tools/call",
    { name, arguments: args },
    {
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
  );
  expect(status).toBe(200);
  return body.result.structuredContent;
}

describe("MCP over HTTP", () => {
  it("rejects missing or wrong bearer tokens with 401", async () => {
    const url = await start();
    expect((await rpc(url, "tools/list", undefined, {})).status).toBe(401);
    const wrong = await rpc(url, "tools/list", undefined, { authorization: "Bearer nope" });
    expect(wrong.status).toBe(401);
  });

  it("fails closed with 503 in production when GB_MCP_TOKEN is unset", async () => {
    const url = await start({ mcpAuth: { nodeEnv: "production" } });
    const res = await rpc(url, "tools/list", undefined, { authorization: "Bearer anything" });
    expect(res.status).toBe(503);
  });

  it("accepts any bearer outside production when GB_MCP_TOKEN is unset", async () => {
    const url = await start({ mcpAuth: { nodeEnv: "development" } });
    const res = await rpc(url, "tools/list", undefined, { authorization: "Bearer whatever" });
    expect(res.status).toBe(200);
  });

  it("initialize, tools/list, then create_run -> approve only when the phase is ready", async () => {
    const store = new InMemoryRunStore();
    const url = await start({
      runStore: store,
      humanAuth: { secret: FIXTURE_KEY, maxAgeSeconds: 300, agentCredential: TOKEN },
    });

    const init = await rpc(url, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.protocolVersion).toBe("2025-06-18");

    const list = await rpc(url, "tools/list");
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "create_run",
      "get_run",
      "approve",
    ]);

    const created = await tool(url, "create_run", { request: "add a /status page" });
    expect(created.status).toBe("active");
    expect(created.phase).toBe("queued");
    const { runId } = created;

    const agentOnly = await tool(url, "approve", { runId, checkpoint: "CP1" });
    expect(agentOnly.error).toBe("human_auth_required");
    const tooSoon = await tool(
      url,
      "approve",
      { runId, checkpoint: "CP1" },
      { "x-gb-human-authorization": humanHeader() },
    );
    expect(tooSoon.error).toBe("not_ready");

    for (const [phase, checkpoint] of [
      ["awaiting_cp1", "CP1"],
      ["awaiting_cp2", "CP2"],
      ["awaiting_cp3", "CP3"],
    ] as const) {
      store.setPhase(runId, phase);
      const approved = await tool(
        url,
        "approve",
        { runId, checkpoint },
        { "x-gb-human-authorization": humanHeader() },
      );
      expect(approved.checkpoint).toBe(checkpoint);
    }

    const run = await tool(url, "get_run", { runId });
    expect(run.status).toBe("needs_human");
    expect(run.phaseReason).toBe("simulation_not_success");
    expect(run.stage).toBe("approved");
    expect(run.request).toBe("add a /status page");
    expect(run.approvals).toHaveLength(3);
  });

  it("answers notifications with 202 and no body", async () => {
    const url = await start();
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("returns a JSON-RPC parse error for malformed JSON", async () => {
    const url = await start();
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("GET /mcp is 405", async () => {
    const url = await start();
    const res = await fetch(`${url}/mcp`);
    expect(res.status).toBe(405);
  });

  it("keeps the credit hard-stop on /mcp", async () => {
    const url = await start();
    const res = await rpc(url, "tools/list", undefined, {
      authorization: `Bearer ${TOKEN}`,
      "x-gb-estimate-cost-usd": "1000",
    });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("credit_hard_stop");
  });
});
