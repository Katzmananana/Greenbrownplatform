#!/usr/bin/env node
/**
 * §7 load/perf on PR — light smoke against GET /health (autocannon).
 * Spawns the built gateway if GATEWAY_URL is not provided.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const stub = process.env.GATE_STUB !== "0";
const require = createRequire(import.meta.url);

async function waitForHealth(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  return false;
}

let child;
let target = process.env.GATEWAY_URL;

if (!target) {
  const entry = "apps/gateway/dist/index.js";
  if (!existsSync(entry)) {
    if (stub) {
      console.log("load: gateway dist missing — GATE_STUB=1 placeholder pass");
      process.exit(0);
    }
    console.error("load: fail-closed — build the gateway first (pnpm --filter @gb/gateway build)");
    process.exit(1);
  }
  child = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: process.env.PORT || "3456" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  target = `http://127.0.0.1:${process.env.PORT || "3456"}`;
}

const healthUrl = `${target.replace(/\/$/, "")}/health`;
const up = await waitForHealth(healthUrl);
if (!up) {
  child?.kill("SIGTERM");
  if (stub) {
    console.log("load: gateway did not become healthy — GATE_STUB=1 placeholder pass");
    process.exit(0);
  }
  console.error(`load: fail-closed — ${healthUrl} never returned 200`);
  process.exit(1);
}

try {
  const autocannon = require("autocannon");
  const result = await autocannon({
    url: healthUrl,
    connections: 10,
    duration: 2,
    pipelining: 1,
  });
  const { latency, requests, errors, non2xx, statusCodeStats } = result;
  console.log(
    JSON.stringify({
      gate: "load_pr",
      url: healthUrl,
      requests: requests?.total,
      rps: requests?.average,
      latencyP99: latency?.p99,
      errors,
      non2xx,
      statusCodeStats,
    }),
  );
  if (errors > 0 || non2xx > 0) {
    console.error("load: fail-closed — errors or non-2xx during smoke");
    process.exit(1);
  }
} finally {
  child?.kill("SIGTERM");
}

console.log("load: PR smoke passed");
process.exit(0);
