import { describe, expect, it } from "vitest";
import { BLOCKING_GATE_NAMES, BLOCKING_GATES, decideFixLoop } from "../src/index.js";

describe("§7 blocking gates", () => {
  it("lists every required gate as blocking", () => {
    const names = [...BLOCKING_GATE_NAMES].sort();
    expect(names).toEqual(
      [
        "acceptance",
        "e2e",
        "fix_loop",
        "functional",
        "lint",
        "load_pr",
        "load_staging",
        "reviewer",
        "sast",
        "typecheck",
        "unit",
      ].sort(),
    );
    expect(BLOCKING_GATES.every((g) => g.blocking)).toBe(true);
  });

  it("retries until the org_config fix-loop cap, then escalates", () => {
    const config = { maxFixIterations: 3, maxAllowedIterations: 5 };
    expect(decideFixLoop(config, 0).action).toBe("retry");
    expect(decideFixLoop(config, 2).action).toBe("retry");
    expect(decideFixLoop(config, 2).nextIteration).toBe(3);
    expect(decideFixLoop(config, 3).action).toBe("escalate");
    expect(decideFixLoop(config, 3).reason).toBe("fix_loop_cap");
  });

  it("honors maxAllowedIterations when it is lower than maxFixIterations", () => {
    const decision = decideFixLoop({ maxFixIterations: 5, maxAllowedIterations: 2 }, 2);
    expect(decision.action).toBe("escalate");
  });
});
