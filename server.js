import express from "express";
import cors from "cors";
import morgan from "morgan";

// uses global fetch (Node 18+)
// ----- Config -----
const SMARTSEARCH_BASE = process.env.SMARTSEARCH_BASE || "https://api2.smartsearchonline.com/openapi/v1";
const SMARTSEARCH_API_KEY = process.env.SMARTSEARCH_API_KEY;
const SS_USER = process.env.SS_USER;
const SS_PASS = process.env.SS_PASS;
const PROXY_KEY = process.env.PROXY_KEY;
const PORT = process.env.PORT || 10000;

const ALLOW_LIST = new Set(["applicants","businesses","candidates","contacts","documents","hires","jobs","notes","offers","projects"]);
const PATH_ALIASES = { applicants: "job/applicants" };

const app = express();
app.use(cors());
app.use(morgan("tiny"));
app.use(express.json());

app.use((req, res, next) => {
  if (!PROXY_KEY) return next();
  if (req.header("X-Proxy-Key") !== PROXY_KEY) return res.status(401).json({ error: "Bad proxy key" });
  next();
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

let bearer = null;
let bearerExpiresAt = 0;

function parseExpiresIn(value) {
  if (!value) return null;
  if (/^\d+$/.test(String(value))) return Number(value) * 1000;
  const d = Date.parse(value);
  return Number.isNaN(d) ? null : (d - Date.now());
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

async function getBearer() {
  const earlySkewMs = 120000;
  if (bearer && Date.now() < bearerExpiresAt - earlySkewMs) return bearer;
  if (!SMARTSEARCH_API_KEY || !SS_USER || !SS_PASS) throw new Error("Missing SMARTSEARCH_API_KEY or SS_USER or SS_PASS");

  const r = await fetch(`${SMARTSEARCH_BASE}/accounts`, {
    method: "POST",
    headers: {
      "X-API-KEY": SMARTSEARCH_API_KEY,
      "Accept": "application/json;odata.metadata=minimal;odata.streaming=true",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ userName: SS_USER, password: SS_PASS })
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Auth failed ${r.status}: ${txt}`);
  const data = safeJson(txt);
  if (!data?.accessToken) throw new Error(`Auth payload missing accessToken: ${txt}`);

  bearer = data.accessToken;
  const ms = parseExpiresIn(data.expiresIn) ?? 30 * 60 * 1000;
  bearerExpiresAt = Date.now() + ms;
  return bearer;
}

function buildUrls(resource, id) {
  const base1 = id ? `${SMARTSEARCH_BASE}/${resource}/${encodeURIComponent(id)}` : `${SMARTSEARCH_BASE}/${resource}`;
  const base2 = PATH_ALIASES[resource] ? (id
    ? `${SMARTSEARCH_BASE}/${PATH_ALIASES[resource]}/${encodeURIComponent(id)}`
    : `${SMARTSEARCH_BASE}/${PATH_ALIASES[resource]}`) : null;
  return [base1, base2];
}

function upstreamHeaders(b) {
  return {
    "X-API-KEY": SMARTSEARCH_API_KEY,
    "Accept": "application/json;odata.metadata=minimal;odata.streaming=true",
    "Authorization": `Bearer ${b}`
  };
}

app.get("/proxy/:resource", async (req, res) => {
  try {
    const { resource } = req.params;
    if (!ALLOW_LIST.has(resource)) return res.status(404).json({ error: "Resource not allowed" });

    const b = await getBearer();
    const [u1, u2] = buildUrls(resource, null);
    const url1 = new URL(u1);
    const url2 = u2 ? new URL(u2) : null;
    for (const [k, v] of Object.entries(req.query)) { url1.searchParams.set(k, v); if (url2) url2.searchParams.set(k, v); }

    let r = await fetch(url1.toString(), { method: "GET", headers: upstreamHeaders(b) });
    if (r.status === 404 && url2) { r = await fetch(url2.toString(), { method: "GET", headers: upstreamHeaders(b) }); res.set("X-Proxy-Upstream", url2.toString()); }
    else { res.set("X-Proxy-Upstream", url1.toString()); }

    const body = await r.text();
    return res.status(r.status).type(r.headers.get("content-type") || "application/json").send(body);
  } catch (e) {
    return res.status(500).json({ error: "Proxy fetch failed", detail: String(e) });
  }
});

app.get("/proxy/:resource/:id", async (req, res) => {
  try {
    const { resource, id } = req.params;
    if (!ALLOW_LIST.has(resource)) return res.status(404).json({ error: "Resource not allowed" });

    const b = await getBearer();
    const [u1, u2] = buildUrls(resource, id);

    let r = await fetch(u1.toString(), { method: "GET", headers: upstreamHeaders(b) });
    if (r.status === 404 && u2) { r = await fetch(u2.toString(), { method: "GET", headers: upstreamHeaders(b) }); res.set("X-Proxy-Upstream", u2.toString()); }
    else { res.set("X-Proxy-Upstream", u1.toString()); }

    const body = await r.text();
    return res.status(r.status).type(r.headers.get("content-type") || "application/json").send(body);
  } catch (e) {
    return res.status(500).json({ error: "Proxy fetch failed", detail: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy listening on :${PORT}`);
});
