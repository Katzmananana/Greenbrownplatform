import { describe, expect, it } from "vitest";
import { createRunStoreFromEnv } from "../src/store/index.js";

// Opt-in: GB_TEST_DATABASE_URL must point at a database with 001 + 002 applied,
// and the `pg` package must be installed in @gb/gateway.
const url = process.env.GB_TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresRunStore (integration)", () => {
  it("creates, approves in order, and reads back a run", async () => {
    const store = await createRunStoreFromEnv({ DATABASE_URL: url });
    expect(store.kind).toBe("postgres");
    try {
      const run = await store.createRun({ request: "integration test run" });
      expect(run.stage).toBe("awaiting_cp1");
      await store.approve({ runId: run.runId, checkpoint: "CP1", userId: "it" });
      const outOfOrder = store.approve({ runId: run.runId, checkpoint: "CP3", userId: "it" });
      await expect(outOfOrder).rejects.toMatchObject({ code: "out_of_order" });
      await store.approve({ runId: run.runId, checkpoint: "CP2", userId: "it" });
      const done = await store.approve({ runId: run.runId, checkpoint: "CP3", userId: "it" });
      expect(done.status).toBe("succeeded");
      expect(done.request).toBe("integration test run");
      expect(await store.getRun("not-a-uuid")).toBeNull();
    } finally {
      await store.close?.();
    }
  });
});
