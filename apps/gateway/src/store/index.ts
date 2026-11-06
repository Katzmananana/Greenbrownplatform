import { InMemoryRunStore } from "./memory.js";
import { type PgPoolLike, PostgresRunStore } from "./postgres.js";
import type { RunStore } from "./types.js";

export { InMemoryRunStore } from "./memory.js";
export { PostgresRunStore } from "./postgres.js";
export type { PgClientLike, PgPoolLike, PgQueryable } from "./postgres.js";
export * from "./types.js";
export * from "./workflow.js";

type PoolCtor = new (config: { connectionString: string; max?: number }) => PgPoolLike;

export interface StoreLogger {
  warn(message: string): void;
}

/**
 * Prefer Postgres when DATABASE_URL is set; otherwise use the in-memory store.
 * `GB_RUN_STORE=memory` forces in-memory. The `pg` driver is loaded lazily so
 * local/dev builds and tests work without it; if DATABASE_URL is set but `pg`
 * cannot be loaded we log loudly and fall back to memory.
 */
export async function createRunStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  logger: StoreLogger = console,
): Promise<RunStore> {
  const url = env.DATABASE_URL?.trim();
  if (!url || env.GB_RUN_STORE === "memory") {
    return new InMemoryRunStore();
  }
  try {
    const moduleName = "pg";
    const mod = (await import(moduleName)) as { default?: { Pool?: PoolCtor }; Pool?: PoolCtor };
    const Pool = mod.default?.Pool ?? mod.Pool;
    if (!Pool) throw new Error("pg module has no Pool export");
    return new PostgresRunStore(new Pool({ connectionString: url, max: 5 }));
  } catch (err) {
    logger.warn(
      JSON.stringify({
        msg: "DATABASE_URL is set but the pg driver could not be loaded; using in-memory run store",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return new InMemoryRunStore();
  }
}
