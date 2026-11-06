import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3001);
const app = createApp();
const server = app.listen(port, () => {
  console.log(JSON.stringify({ msg: "orchestrator listening", port, mode: "fix-loop stub" }));
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ msg: "orchestrator shutting down", signal }));
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
