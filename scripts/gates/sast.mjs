#!/usr/bin/env node
/**
 * §7 SAST / security. No paid SaaS.
 * 1) Regex scan of first-party source for secrets / dangerous defaults.
 * 2) pnpm audit --audit-level=critical (fail-closed in real mode; reported in stub).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const stub = process.env.GATE_STUB !== "0";
const root = process.cwd();
const skipDir = new Set(["node_modules", "dist", "coverage", ".git", ".pnpm-store"]);

const patterns = [
  { name: "aws_access_key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "private_key", re: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/ },
  {
    name: "hardcoded_api_key",
    re: /(?:api[_-]?key|secret|password)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{20,}['"]/i,
  },
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (skipDir.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (/\.(ts|js|mjs|cjs|json|yml|yaml|env)$/.test(entry) && entry !== ".env.example") {
      files.push(full);
    }
  }
  return files;
}

const findings = [];
for (const file of walk(root)) {
  const rel = relative(root, file);
  if (rel.startsWith("scripts/gates/sast")) continue;
  const text = readFileSync(file, "utf8");
  for (const { name, re } of patterns) {
    if (re.test(text)) findings.push({ file: rel, name });
  }
}

if (findings.length > 0) {
  console.error(
    "sast: fail-closed — secret-like patterns in first-party source (NEEDS_HUMAN if critical):",
  );
  for (const f of findings) console.error(`  - ${f.file}: ${f.name}`);
  process.exit(1);
}

let auditOk = true;
try {
  execFileSync("pnpm", ["audit", "--audit-level", "critical"], { stdio: "pipe" });
  console.log("sast: pnpm audit --audit-level=critical clean");
} catch (err) {
  auditOk = false;
  const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  console.error("sast: pnpm audit reported critical issues");
  console.error(output.slice(0, 4000));
  if (!stub) {
    console.error("sast: fail-closed (GATE_STUB=0)");
    process.exit(1);
  }
  console.log("sast: GATE_STUB=1 — audit findings logged, not blocking lab stub");
}

console.log(`sast: source scan clean; audit=${auditOk ? "clean" : "see-above"}`);
process.exit(0);
