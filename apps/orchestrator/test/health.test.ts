import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type LoopStatus } from "../src/app.js";
import { readEnv } from "../src/env.js";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => (err ? reject(err) : resolve()));
  });
  server = undefined;
});

function status(partial: Partial<LoopStatus> = {}): LoopStatus {
  return {
    queue: "off",
    database: false,
    redis: false,
    pollMs: 2000,
    lastTickAt: null,
    lastError: null,
    ...partial,
  };
}

describe("orchestrator http", () => {
  it("reports lifecycle health", async () => {
    const app = createApp(status({ queue: "bullmq", database: true, redis: true }));
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const res = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      mode: string;
      queue: string;
      database: boolean;
    };
    expect(body).toMatchObject({
      status: "ok",
      service: "orchestrator",
      mode: "lifecycle",
      queue: "bullmq",
      database: true,
      redis: true,
    });
  });

  it("still answers the fix-loop decision helper", async () => {
    const app = createApp(status());
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");
    const res = await fetch(`http://127.0.0.1:${address.port}/internal/fix-loop/next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ iteration: 3 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string; reason?: string };
    expect(body.action).toBe("escalate");
    expect(body.reason).toBe("fix_loop_cap");
  });
});

describe("readEnv", () => {
  it("defaults the loop and treats blank URLs as unset", () => {
    const env = readEnv({
      PORT: "3010",
      DATABASE_URL: "  ",
      REDIS_URL: "",
      GB_GATES_FAIL: "unit, lint",
    });
    expect(env).toMatchObject({
      port: 3010,
      databaseUrl: null,
      redisUrl: null,
      pollMs: 2000,
      leaseSeconds: 30,
      batchSize: 10,
      estimateUsd: 0,
      failGates: ["unit", "lint"],
    });
  });
});
