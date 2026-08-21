// Scenteno Commenter — remote dashboard server (Railway).
// Receives run reports from the browser extension, stores them in Postgres,
// and serves the dashboard (same files as the extension) behind a password.
//
// Env: DATABASE_URL (Railway Postgres), INGEST_TOKEN, DASHBOARD_PASSWORD, PORT

import express from "express";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { DATABASE_URL, INGEST_TOKEN, DASHBOARD_PASSWORD, PORT = 3000 } = process.env;
for (const k of ["DATABASE_URL", "INGEST_TOKEN", "DASHBOARD_PASSWORD"])
  if (!process.env[k]) { console.error(`Missing env var ${k}`); process.exit(1); }

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes("railway") ? { rejectUnauthorized: false } : undefined });
await pool.query(`
  CREATE TABLE IF NOT EXISTS runs (
    id BIGSERIAL PRIMARY KEY, source TEXT, kind TEXT, dry_run BOOLEAN, trigger TEXT,
    started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, fatal TEXT, results JSONB,
    UNIQUE (source, kind, started_at));
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY, kind TEXT, status TEXT, ts TIMESTAMPTZ, source TEXT);
  CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value JSONB);
  CREATE TABLE IF NOT EXISTS failures (
    id BIGSERIAL PRIMARY KEY, source TEXT, item_id TEXT, error TEXT, ts TIMESTAMPTZ,
    screenshot TEXT, html TEXT, UNIQUE (source, item_id, ts));
`);

const app = express();
app.use(express.json({ limit: "25mb" })); // screenshots + saved HTML ride along

// ---------- ingest (from the extension) ----------
app.options("/api/runs", cors, (_q, res) => res.sendStatus(204));
app.post("/api/runs", cors, async (req, res) => {
  if (req.get("authorization") !== `Bearer ${INGEST_TOKEN}`) return res.status(401).json({ error: "bad token" });
  const { source = "unknown", runs = [], state = {}, failures = [] } = req.body || {};
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const r of runs)
      await c.query(
        `INSERT INTO runs (source, kind, dry_run, trigger, started_at, ended_at, fatal, results)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (source, kind, started_at) DO NOTHING`,
        [source, r.kind, !!r.dryRun, r.trigger || "manual", r.startedAt, r.endedAt, r.fatal || null, JSON.stringify(r.results || [])]);
    for (const [id, v] of Object.entries(state))
      await c.query(
        `INSERT INTO items (id, kind, status, ts, source) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind, status=EXCLUDED.status, ts=EXCLUDED.ts, source=EXCLUDED.source
         WHERE EXCLUDED.ts >= items.ts`,
        [id, v.kind, v.status, v.ts, source]);
    for (const f of failures)
      await c.query(
        `INSERT INTO failures (source, item_id, error, ts, screenshot, html) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (source, item_id, ts) DO NOTHING`,
        [source, f.id, f.error, f.ts, f.screenshot || null, f.html ? String(f.html).slice(0, 600000) : null]);
    // keep the table small — screenshots are the only heavy thing we store
    await c.query(`DELETE FROM failures WHERE id NOT IN (SELECT id FROM failures ORDER BY ts DESC LIMIT 50)`);
    await c.query("COMMIT");
    res.json({ ok: true, runs: runs.length, items: Object.keys(state).length, failures: failures.length });
  } catch (e) {
    await c.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    c.release();
  }
});

// Comment texts — read by the extension at the start of each run (token), edited from the dashboard (password).
async function getComments() {
  const { rows } = await pool.query(`SELECT value FROM config WHERE key = 'comments'`);
  return rows[0]?.value || null;
}
app.options("/api/config", cors, (_q, res) => res.sendStatus(204));
app.get("/api/config", cors, async (req, res) => {
  if (req.get("authorization") !== `Bearer ${INGEST_TOKEN}`) return res.status(401).json({ error: "bad token" });
  res.json({ comments: await getComments() });
});

// ---------- dashboard (password-protected) ----------
app.use(basicAuth);
app.get("/api/data", async (_req, res) => {
  const [runs, items, failures] = await Promise.all([
    pool.query(`SELECT source, kind, dry_run AS "dryRun", trigger, started_at AS "startedAt", ended_at AS "endedAt", fatal, results
                FROM runs ORDER BY ended_at DESC LIMIT 200`),
    pool.query(`SELECT id, kind, status, ts, source FROM items`),
    pool.query(`SELECT source, item_id AS id, error, ts, screenshot, (html IS NOT NULL) AS "hasHtml", id AS "failureId"
                FROM failures ORDER BY ts DESC LIMIT 50`),
  ]);
  const state = Object.fromEntries(items.rows.map((r) => [r.id, { kind: r.kind, status: r.status, ts: r.ts, source: r.source }]));
  res.json({ runs: runs.rows, state, failures: failures.rows });
});
app.get("/api/comments", async (_req, res) => res.json(await getComments()));
app.put("/api/comments", async (req, res) => {
  const { bos, hod, hodKeyword } = req.body || {};
  if (typeof bos !== "string" || typeof hod !== "string" || !bos.trim() || !hod.trim())
    return res.status(400).json({ error: "bos and hod must be non-empty strings" });
  const value = { bos: bos.trim(), hod: hod.trim(), hodKeyword: (hodKeyword || "house of dastan").trim().toLowerCase() };
  await pool.query(`INSERT INTO config (key, value) VALUES ('comments', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(value)]);
  res.json(value);
});
app.get("/api/failures/:id/html", async (req, res) => {
  const { rows } = await pool.query(`SELECT html FROM failures WHERE id = $1`, [req.params.id]);
  if (!rows[0]?.html) return res.sendStatus(404);
  res.type("html").send(rows[0].html);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(here, "..", "extension");
app.get("/", (_q, res) => res.sendFile(path.join(ext, "dashboard.html")));
app.get("/dashboard.js", (_q, res) => res.sendFile(path.join(ext, "dashboard.js")));

app.listen(PORT, () => console.log(`dashboard on :${PORT}`));

// ---------- helpers ----------
function cors(_req, res, next) {
  res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
  next();
}
function basicAuth(req, res, next) {
  const [, b64 = ""] = (req.get("authorization") || "").split(" ");
  const pass = Buffer.from(b64, "base64").toString().split(":").slice(1).join(":");
  if (pass === DASHBOARD_PASSWORD) return next();
  res.set("WWW-Authenticate", 'Basic realm="Scenteno Commenter"').status(401).send("Password required");
}
