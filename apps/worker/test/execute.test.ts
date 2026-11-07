import { describe, expect, it, vi } from "vitest";
import type { AgentJobPayload } from "@gb/shared";
import { executeQueuedJob } from "../src/complete.js";
import { handleAgentJob } from "../src/handle.js";

const payload: AgentJobPayload = {
  v: 1,
  name: "plan",
  runId: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  iteration: 0,
  role: "planner",
  requestText: null,
};

describe("worker execution guard", () => {
  it("does not run the handler when no durable store is configured", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const outcome = await executeQueuedJob(undefined, "plan", payload);
    expect(outcome).toEqual({ executed: false, reason: "durable_store_required", result: null });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("does not start the stub effect when cancellation is already set", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = handleAgentJob("plan", payload, { cancelled: () => true });
    expect(result.externalEffect).toBe("none");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("reports an unknown external effect if cancellation is observed after the stub log", () => {
    let cancelled = false;
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      cancelled = true;
    });
    const result = handleAgentJob("plan", payload, { cancelled: () => cancelled });
    expect(result.externalEffect).toBe("unknown");
    log.mockRestore();
  });
});
