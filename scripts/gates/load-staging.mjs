#!/usr/bin/env node
/**
 * §7 load/perf on staging — placeholder until a staging URL exists.
 * Real mode (GATE_STUB=0) fails closed without STAGING_URL.
 */
const stub = process.env.GATE_STUB !== "0";
const url = process.env.STAGING_URL;
const path = process.env.STAGING_HEALTH_PATH || "/health";

if (!url) {
  if (stub) {
    console.log("load-staging: placeholder — STAGING_URL unset, GATE_STUB=1");
    process.exit(0);
  }
  console.error("load-staging: fail-closed — STAGING_URL missing (blocks CP3)");
  process.exit(1);
}

const healthUrl = `${url.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
try {
  const res = await fetch(healthUrl);
  if (!res.ok) {
    console.error(`load-staging: fail-closed — ${healthUrl} returned ${res.status}`);
    process.exit(1);
  }
  console.log(`load-staging: ${healthUrl} ${res.status}`);
  process.exit(0);
} catch (err) {
  console.error(`load-staging: fail-closed — ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
