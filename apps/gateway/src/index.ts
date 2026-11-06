import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const app = createApp({ service: process.env.GB_SERVICE_NAME ?? "gateway" });

const server = app.listen(port, () => {
  console.log(JSON.stringify({ msg: "gateway listening", port, health: "/health" }));
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ msg: "gateway shutting down", signal }));
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
