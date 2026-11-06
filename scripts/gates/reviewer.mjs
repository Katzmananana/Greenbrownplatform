#!/usr/bin/env node
/**
 * §7 Reviewer gate. Always runs.
 * Lab default: GATE_STUB=1 → pass (stub mode).
 * Real mode (GATE_STUB=0): fail-closed if REVIEWER_TOKEN is missing
 * or if the live reviewer path is not yet wired.
 */
const stub = process.env.GATE_STUB !== "0";
const token = process.env.REVIEWER_TOKEN;

if (stub) {
  console.log("reviewer: GATE_STUB=1 (lab) — stub pass");
  console.log("reviewer: set GATE_STUB=0 and REVIEWER_TOKEN to enable fail-closed real mode");
  process.exit(0);
}

if (!token) {
  console.error("reviewer: NEEDS_HUMAN — REVIEWER_TOKEN missing; fail-closed");
  process.exit(1);
}

console.error("reviewer: real mode is structured but not wired to a model yet; fail-closed");
console.error(
  "reviewer: NEEDS_HUMAN — connect a reviewer model (separate from coder/fixer) before disabling stub mode",
);
process.exit(1);
