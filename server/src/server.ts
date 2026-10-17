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
