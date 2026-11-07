import { describe, expect, it } from "vitest";
import { createRunStoreFromEnv } from "../src/store/index.js";

// Opt-in: GB_TEST_DATABASE_URL must point at a database with 001 + 002 applied.
// Phase column from 003 is optional: a missing phase is treated as queued.
const url = process.env.GB_TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresRunStore (integration)", () => {
  it("does not accept CP1 until the orchestrator phase is awaiting_cp1", async () => {
    const store = await createRunStoreFromEnv({ DATABASE_URL: url });
    expect(store.kind).toBe("postgres");
    try {
      const run = await store.createRun({ request: "integration test run" });
      expect(run.phase).toBe("queued");
      expect(run.stage).toBe("awaiting_cp1");
      await expect(
        store.approve({ runId: run.runId, checkpoint: "CP1", userId: "it" }),
      ).rejects.toMatchObject({ code: "not_ready" });
      const stored = await store.getRun(run.runId);
      expect(stored?.status).toBe("active");
      expect(stored?.approvals).toEqual([]);
      expect(await store.getRun("not-a-uuid")).toBeNull();
    } finally {
      await store.close?.();
    }
  });
});
