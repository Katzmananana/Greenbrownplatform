import express from "express";

const port = Number(process.env.PORT ?? 3002);
const app = express();
app.disable("x-powered-by");

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Akshi admin stub</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 3rem; color: #142015; background: #f4f7f2; }
    main { max-width: 40rem; }
    .ok { color: #1b7a3d; font-weight: 600; }
    code { background: #e4eadc; padding: 0.1rem 0.35rem; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <p class="ok">status: ok</p>
    <h1>Akshi / Green-Brown admin stub</h1>
    <p>Lab-scale control surface placeholder. Human checkpoints <code>CP1</code>, <code>CP2</code>, and <code>CP3</code> will land here; this page only proves the web service is up.</p>
    <p>Health JSON: <a href="/health">/health</a></p>
  </main>
</body>
</html>`;

app.get("/", (_req, res) => {
  res.status(200).type("html").send(page);
});

app.get(["/health", "/healthz", "/readyz"], (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "web",
    platform: "akshi-green-brown",
    time: new Date().toISOString(),
  });
});

const server = app.listen(port, () => {
  console.log(JSON.stringify({ msg: "web listening", port }));
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ msg: "web shutting down", signal }));
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
