import { createApp } from "./app.js";
import { createRunStoreFromEnv } from "./store/index.js";

const port = Number(process.env.PORT ?? 3000);
const runStore = await createRunStoreFromEnv();
const app = createApp({ service: process.env.GB_SERVICE_NAME ?? "gateway", runStore });

const server = app.listen(port, () => {
  console.log(
    JSON.stringify({
      msg: "gateway listening",
      port,
      health: "/health",
      mcp: "/mcp",
      runStore: runStore.kind,
      mcpAuth: process.env.GB_MCP_TOKEN ? "token" : "any-bearer (non-production only)",
    }),
  );
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ msg: "gateway shutting down", signal }));
  server.close(() => {
    void Promise.resolve(runStore.close?.()).finally(() => process.exit(0));
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
