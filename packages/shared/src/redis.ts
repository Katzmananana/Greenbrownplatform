/** Options both the orchestrator Queue and the worker accept. */
export interface BullmqConnection {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
}

export function bullmqConnectionFromUrl(urlStr: string): BullmqConnection {
  const url = new URL(urlStr);
  const connection: BullmqConnection = {
    host: url.hostname,
    port: Number(url.port || 6379),
    maxRetriesPerRequest: null,
  };
  if (url.username) connection.username = decodeURIComponent(url.username);
  if (url.password) connection.password = decodeURIComponent(url.password);
  if (url.protocol === "rediss:") connection.tls = {};
  if (url.pathname && url.pathname !== "/") {
    const db = Number(url.pathname.slice(1));
    if (Number.isInteger(db) && db >= 0) connection.db = db;
  }
  return connection;
}
