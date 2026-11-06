#!/usr/bin/env node
/**
 * §7 Acceptance vs the original requirement.
 * Real mode: fail-closed when no run artifact is present.
 * Lab stub (GATE_STUB=1): falls back to fixtures/acceptance-artifact.md.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const stub = process.env.GATE_STUB !== "0";
const requirementPath = resolve(process.env.REQUIREMENT_PATH || "fixtures/requirement.md");
const runArtifact = process.env.ACCEPTANCE_ARTIFACT_PATH;
const artifactPath = runArtifact
  ? resolve(runArtifact)
  : stub
    ? resolve("fixtures/acceptance-artifact.md")
    : null;

if (!artifactPath || !existsSync(artifactPath)) {
  console.error("acceptance: fail-closed — no run artifact vs original requirement");
  process.exit(1);
}
if (!existsSync(requirementPath)) {
  console.error(`acceptance: fail-closed — requirement text missing at ${requirementPath}`);
  process.exit(1);
}

const requirement = readFileSync(requirementPath, "utf8");
const artifact = readFileSync(artifactPath, "utf8");
if (!artifact.trim()) {
  console.error("acceptance: fail-closed — empty artifact");
  process.exit(1);
}

const musts = requirement
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("MUST "))
  .map((line) => line.slice(5).trim());

const missing = [];
for (const must of musts) {
  const tokens = must
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 3);
  const haystack = artifact.toLowerCase();
  const hits = tokens.filter((t) => haystack.includes(t)).length;
  if (tokens.length > 0 && hits / tokens.length < 0.5) {
    missing.push(must);
  }
}

if (missing.length > 0) {
  console.error("acceptance: fail-closed — artifact does not cover original MUST lines:");
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}

console.log(`acceptance: passed (${musts.length} MUST lines covered) artifact=${artifactPath}`);
process.exit(0);
