import { beforeEach, describe, expect, it } from "vitest";
import { checkBearer } from "../src/mcp/auth.js";
import { JSONRPC_ERRORS, handleJsonRpc } from "../src/mcp/server.js";
import {
  TOOL_DEFINITIONS,
  type ToolContext,
  approveTool,
  callTool,
  createRunTool,
  getRunTool,
} from "../src/mcp/tools.js";
import { InMemoryRunStore } from "../src/store/memory.js";
import { createRunStoreFromEnv } from "../src/store/index.js";
import { nextCheckpoint, stageFor } from "../src/store/workflow.js";

let ctx: ToolContext;

beforeEach(() => {
  ctx = { store: new InMemoryRunStore(), principal: "bearer:test", ip: "127.0.0.1" };
});

async function newRunId(): Promise<string> {
  const created = await createRunTool({ request: "add a /status page" }, ctx);
  return String(created.runId);
}

describe("workflow", () => {
  it("walks CP1 -> CP2 -> CP3 -> approved", () => {
    expect(stageFor([])).toBe("awaiting_cp1");
    expect(stageFor(["CP1"])).toBe("awaiting_cp2");
    expect(stageFor(["CP1", "CP2"])).toBe("awaiting_cp3");
    expect(stageFor(["CP1", "CP2", "CP3"])).toBe("approved");
    expect(nextCheckpoint(["CP1", "CP2", "CP3"])).toBeNull();
  });
});

describe("create_run", () => {
  it("creates an active run awaiting CP1", async () => {
    const out = await createRunTool({ request: "  add a /status page  " }, ctx);
    expect(out.status).toBe("active");
    expect(out.stage).toBe("awaiting_cp1");
    expect(typeof out.runId).toBe("string");
    const run = await ctx.store.getRun(String(out.runId));
    expect(run?.request).toBe("add a /status page");
  });

  it("rejects an empty request as a tool error", async () => {
    const res = await callTool("create_run", { request: "   " }, ctx);
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toBe("invalid_arguments");
  });

  it("rejects non-object arguments", async () => {
    const res = await callTool("create_run", ["x"], ctx);
    expect(res.isError).toBe(true);
  });
});

describe("get_run", () => {
  it("returns run details", async () => {
    const runId = await newRunId();
    const out = await getRunTool({ runId }, ctx);
    expect(out.runId).toBe(runId);
    expect(out.status).toBe("active");
    expect(out.approvals).toEqual([]);
  });

  it("returns not_found for an unknown run", async () => {
    const res = await callTool("get_run", { runId: "nope" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toBe("not_found");
  });
});

describe("approve", () => {
  it("advances CP1 -> CP2 -> CP3 and closes the run as succeeded", async () => {
    const runId = await newRunId();

    const cp1 = await approveTool({ runId, checkpoint: "CP1", comment: "plan ok" }, ctx);
    expect(cp1.stage).toBe("awaiting_cp2");
    expect(cp1.status).toBe("active");

    const cp2 = await approveTool({ runId, checkpoint: "CP2" }, ctx);
    expect(cp2.stage).toBe("awaiting_cp3");

    const cp3 = await approveTool({ runId, checkpoint: "CP3" }, ctx);
    expect(cp3.stage).toBe("approved");
    expect(cp3.status).toBe("succeeded");

    const run = await ctx.store.getRun(runId);
    expect(run?.approvals.map((a) => a.checkpoint)).toEqual(["CP1", "CP2", "CP3"]);
    expect(run?.approvals[0]?.userId).toBe("bearer:test");
    expect(run?.approvals[0]?.comment).toBe("plan ok");
    expect(run?.endedAt).not.toBeNull();
    expect(run?.version).toBe(4);
  });

  it("rejects out-of-order approval", async () => {
    const runId = await newRunId();
    const res = await callTool("approve", { runId, checkpoint: "CP2" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toBe("out_of_order");
  });

  it("rejects a duplicate approval", async () => {
    const runId = await newRunId();
    await approveTool({ runId, checkpoint: "CP1" }, ctx);
    const res = await callTool("approve", { runId, checkpoint: "CP1" }, ctx);
    expect(res.structuredContent.error).toBe("already_approved");
  });

  it("rejects an invalid checkpoint", async () => {
    const runId = await newRunId();
    const res = await callTool("approve", { runId, checkpoint: "CP4" }, ctx);
    expect(res.structuredContent.error).toBe("invalid_arguments");
  });

  it("returns not_found for an unknown run", async () => {
    const res = await callTool("approve", { runId: "missing", checkpoint: "CP1" }, ctx);
    expect(res.structuredContent.error).toBe("not_found");
  });
});

describe("JSON-RPC dispatch", () => {
  it("initialize negotiates protocol version and advertises tools", async () => {
    const res = await handleJsonRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      ctx,
    );
    expect(res).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
    });
  });

  it("tools/list returns the three tools", async () => {
    const res = await handleJsonRpc({ jsonrpc: "2.0", id: "a", method: "tools/list" }, ctx);
    const { tools } = (res as { result: { tools: { name: string }[] } }).result;
    expect(tools.map((t) => t.name)).toEqual(["create_run", "get_run", "approve"]);
    expect(TOOL_DEFINITIONS).toHaveLength(3);
  });

  it("tools/call wraps results as MCP content", async () => {
    const res = (await handleJsonRpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "create_run", arguments: { request: "x" } },
      },
      ctx,
    )) as { result: { isError: boolean; content: { type: string; text: string }[] } };
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0]?.type).toBe("text");
    expect(JSON.parse(res.result.content[0]?.text ?? "{}").status).toBe("active");
  });

  it("unknown tool -> -32602, unknown method -> -32601", async () => {
    const tool = await handleJsonRpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } },
      ctx,
    );
    expect(tool).toMatchObject({ error: { code: JSONRPC_ERRORS.invalidParams } });
    const method = await handleJsonRpc({ jsonrpc: "2.0", id: 4, method: "nope" }, ctx);
    expect(method).toMatchObject({ error: { code: JSONRPC_ERRORS.methodNotFound } });
  });

  it("notifications get no response; malformed requests get -32600", async () => {
    const note = await handleJsonRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx);
    expect(note).toBeNull();
    expect(await handleJsonRpc({ id: 1, method: "ping" }, ctx)).toMatchObject({
      error: { code: JSONRPC_ERRORS.invalidRequest },
    });
    expect(await handleJsonRpc([], ctx)).toMatchObject({
      error: { code: JSONRPC_ERRORS.invalidRequest },
    });
  });
});

describe("auth", () => {
  it("requires the configured token", () => {
    expect(checkBearer("Bearer s3cret", { token: "s3cret" }).ok).toBe(true);
    expect(checkBearer("Bearer wrong", { token: "s3cret" }).ok).toBe(false);
    expect(checkBearer(undefined, { token: "s3cret" }).ok).toBe(false);
  });

  it("accepts any non-empty bearer when no token is set outside production", () => {
    expect(checkBearer("Bearer anything", { nodeEnv: "development" }).ok).toBe(true);
    expect(checkBearer("Bearer ", { nodeEnv: "development" }).ok).toBe(false);
    expect(checkBearer("Basic abc", { nodeEnv: "development" }).ok).toBe(false);
  });

  it("fails closed in production when no token is set", () => {
    const res = checkBearer("Bearer anything", { nodeEnv: "production" });
    expect(res).toMatchObject({ ok: false, status: 503 });
  });
});

describe("store selection", () => {
  it("uses memory without DATABASE_URL", async () => {
    const store = await createRunStoreFromEnv({}, { warn: () => undefined });
    expect(store.kind).toBe("memory");
  });

  it("honours GB_RUN_STORE=memory even with DATABASE_URL", async () => {
    const store = await createRunStoreFromEnv(
      { DATABASE_URL: "postgres://x", GB_RUN_STORE: "memory" },
      { warn: () => undefined },
    );
    expect(store.kind).toBe("memory");
  });
});
