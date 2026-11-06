#!/usr/bin/env node
/**
 * §7 fix-loop orchestration job.
 * Records the retry cap from org_config (fixture until the DB is wired).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.env.ORG_CONFIG_PATH || "fixtures/org-config.json");
if (!existsSync(path)) {
  console.error("fix-loop: fail-closed — org_config not found");
  process.exit(1);
}

const config = JSON.parse(readFileSync(path, "utf8"));
const maxFixIterations = Number(config.maxFixIterations);
const maxAllowedIterations = Number(config.maxAllowedIterations);
if (!Number.isFinite(maxFixIterations) || maxFixIterations < 1) {
  console.error("fix-loop: fail-closed — maxFixIterations missing or invalid");
  process.exit(1);
}

const cap = Math.min(
  maxFixIterations,
  Number.isFinite(maxAllowedIterations) ? maxAllowedIterations : maxFixIterations,
);
const summary = [
  `fix-loop retry cap from org_config: maxFixIterations=${maxFixIterations}`,
  `maxAllowedIterations=${maxAllowedIterations}`,
  `effective cap=${cap}`,
  "after cap → ESCALATED / NEEDS_HUMAN",
].join("\n");

console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## fix-loop cap\n\n\`\`\`\n${summary}\n\`\`\`\n`,
  );
}
process.exit(0);
