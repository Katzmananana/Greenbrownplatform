export interface OrchestratorEnv {
  port: number;
  databaseUrl: string | null;
  redisUrl: string | null;
  pollMs: number;
  leaseSeconds: number;
  batchSize: number;
  estimateUsd: number;
  failGates: string[];
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): OrchestratorEnv {
  return {
    port: intEnv(env.PORT, 3001, 0),
    databaseUrl: trimmed(env.DATABASE_URL),
    redisUrl: trimmed(env.REDIS_URL),
    pollMs: intEnv(env.ORCHESTRATOR_POLL_MS, 2_000, 250),
    leaseSeconds: intEnv(env.ORCHESTRATOR_LEASE_SECONDS, 30, 1),
    batchSize: intEnv(env.ORCHESTRATOR_BATCH, 10, 1),
    estimateUsd: floatEnv(env.GB_AGENT_ESTIMATE_USD, 0),
    failGates: (env.GB_GATES_FAIL ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  };
}

function trimmed(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

function intEnv(value: string | undefined, fallback: number, min: number): number {
  if (value === undefined || value.trim() === "") return Math.max(min, fallback);
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(min, fallback);
  return Math.max(min, Math.floor(n));
}

function floatEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}
