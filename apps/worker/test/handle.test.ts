import { describe, expect, it } from "vitest";
import { agentJobId, bullmqConnectionFromUrl, type AgentJobPayload } from "@gb/shared";
import { handleAgentJob } from "../src/handle.js";

const payload: AgentJobPayload = {
  v: 1,
  name: "code",
  runId: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  iteration: 2,
  role: "coder",
  requestText: "add a /status page",
};

describe("worker job handler", () => {
  it("consumes an orchestrator payload and acks a stub result", () => {
    expect(agentJobId(payload)).toBe(`code.${payload.runId}.2`);
    expect(handleAgentJob("code", payload)).toEqual({
      ok: true,
      stub: true,
      name: "code",
      runId: payload.runId,
      requestId: payload.requestId,
      iteration: 2,
      role: "coder",
      externalEffect: "none",
    });
  });

  it("acks an unrecognised job so the queue does not retry forever", () => {
    expect(handleAgentJob("legacy", { hello: true })).toMatchObject({
      ok: true,
      stub: true,
      name: "legacy",
      runId: null,
      externalEffect: "none",
    });
  });

  it("parses the same Redis URL shape the orchestrator publishes with", () => {
    expect(bullmqConnectionFromUrl("redis://default:s%40cret@127.0.0.1:6380/0")).toMatchObject({
      host: "127.0.0.1",
      port: 6380,
      username: "default",
      password: "s@cret",
      maxRetriesPerRequest: null,
    });
    expect(bullmqConnectionFromUrl("rediss://cache.internal").tls).toEqual({});
  });
});
