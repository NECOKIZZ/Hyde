import express from "express";
import { buildApi } from "./api.js";
import { startWorker } from "./jobs.js";

const port = Number(process.env.PORT ?? 8787);
const app = express();
app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "hyde-api" });
});
app.use("/v1", buildApi());

startWorker();
app.listen(port, () => {
  console.log(`hyde-api listening on :${port}`);
});

// Free hosts (e.g. Render's free tier) sleep after ~15 minutes without inbound requests, which would
// pause the job worker. Pinging our own public URL keeps the instance awake. Render sets
// RENDER_EXTERNAL_URL automatically; KEEPALIVE_URL overrides it elsewhere.
const keepAliveUrl = process.env.KEEPALIVE_URL ?? process.env.RENDER_EXTERNAL_URL;
if (keepAliveUrl) {
  const ping = () =>
    fetch(new URL("/health", keepAliveUrl), { signal: AbortSignal.timeout(10_000) }).catch((err: Error) =>
      console.error(`keep-alive ping failed: ${err.message}`),
    );
  setInterval(ping, Number(process.env.KEEPALIVE_INTERVAL_MS ?? 10 * 60_000));
}
