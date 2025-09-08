import express from "express";
import cors from "cors";
import morgan from "morgan";
import { fetch as undiciFetch } from "undici";

// Use global fetch if present (Node 18+), else Undici
const fetchFn = globalThis.fetch ?? undiciFetch;

// ----- Config -----
const SMARTSEARCH_BASE = process.env.SMARTSEARCH_BASE || "https://api2.smartsearchonline.com/openapi/v1";
const SMARTSEARCH_API_KEY = process.env.SMARTSEARCH_API_KEY;
const SS_USER = process.env.SS_USER;
const SS_PASS = process.env.SS_PASS;
const PROXY_KEY = process.env.PROXY_KEY;
const PORT = process.env.PORT || 10000;

// Whitelist and aliases
const ALLOW_LIST = new Set([
  "applicants",
  "businesses",
  "candidates",
  "contacts",
  "documents",
  "hires",
  "jobs",
  "notes",
  "offers",
  "projects"
]);
const PATH_ALIASES = { applicants: "job/applicants" };

const app = express();
app.use(cors());
app.use(morgan("tiny"));
app.use(express.json());

// Optional shared secret gate
app.use((req, res, next) => {
  if (!PROXY_KEY) return next();
  if (req.header("X-Proxy-Key") !== PROXY_KEY) return res.status(401).json({ error: "Bad proxy key" });
  next();
});

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ----- Bearer cache -----
let bearer = null;
let bearerExpiresAt = 0;

function parseExpiresIn(value) {
  if (!value) return null;
  if (/^\d+$/.test(String(value))) return Number(value) * 1000; // seconds → ms
  const d = Date.parse(value);
  return Number.isNaN(d) ? null : (d - Date.now());
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

async function getBearer() {
  const earlySkewMs = 120000; // refresh 2 min early
  if (bearer && Date.now() < bearerExpiresAt - earlySkewMs) return bearer;

  if (!SMARTSEARCH_API_KEY || !SS_USER || !SS_PASS) {
    throw new Error("Missing SMARTSEARCH_API_KEY or SS_USER or SS_PASS");
  }

  const r = await fetchFn(`${SMARTSEARCH_BASE}/accounts`, {
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
  const primary = id
    ? `${SMARTSEARCH_BASE}/${resource}/${encodeURIComponent(id)}`
    : `${SMARTSEARCH_BASE}/${resource}`;
  const alias = PATH_ALIASES[resource]
    ? (id
        ? `${SMARTSEARCH_BASE}/${PATH_ALIASES[resource]}/${encodeURIComponent(id)}`
        : `${SMARTSEARCH_BASE}/${PATH_ALIASES[resource]}`)
    : null;
  return [primary, alias];
}

function upstreamHeaders(b) {
  return {
    "X-API-KEY": SMARTSEARCH_API_KEY,
    "Accept": "application/json;odata.metadata=minimal;odata.streaming=true",
    "Authorization": `Bearer ${b}`
  };
}

// Debug auth
app.get("/debug/auth", async (_req, res) => {
  try {
    const b = await getBearer();
    res.json({ ok: true, bearerPreview: b.slice(0, 8) + "...", expiresAt: new Date(bearerExpiresAt).toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ----- GET collection with non-2xx fallback -----
app.get("/proxy/:resource", async (req, res) => {
  try {
    const { resource } = req.params;
    if (!ALLOW_LIST.has(resource)) return res.status(404).json({ error: "Resource not allowed" });

    const b = await getBearer();
    const [u1, u2] = buildUrls(resource, null);
    const url1 = new URL(u1);
    const url2 = u2 ? new URL(u2) : null;
    for (const [k, v] of Object.entries(req.query)) {
      url1.searchParams.set(k, v);
      if (url2) url2.searchParams.set(k, v);
    }

    let r = await fetchFn(url1.toString(), { method: "GET", headers: upstreamHeaders(b) });
    let body = await r.text();
    res.set("X-Proxy-Primary-URL", url1.toString());
    res.set("X-Proxy-Primary-Status", String(r.status));

    if (!r.ok && url2) {
      // try alias on any non-2xx
      r = await fetchFn(url2.toString(), { method: "GET", headers: upstreamHeaders(b) });
      body = await r.text();
      res.set("X-Proxy-Upstream", url2.toString());
    } else {
      res.set("X-Proxy-Upstream", url1.toString());
    }

    return res.status(r.status).type(r.headers.get("content-type") || "application/json").send(body);
  } catch (e) {
    console.error("GET /proxy error:", e);
    return res.status(500).json({ error: "Proxy fetch failed", detail: String(e) });
  }
});

// ----- GET by id with non-2xx fallback -----
app.get("/proxy/:resource/:id", async (req, res) => {
  try {
    const { resource, id } = req.params;
    if (!ALLOW_LIST.has(resource)) return res.status(404).json({ error: "Resource not allowed" });

    const b = await getBearer();
    const [u1, u2] = buildUrls(resource, id);

    let r = await fetchFn(u1.toString(), { method: "GET", headers: upstreamHeaders(b) });
    let body = await r.text();
    res.set("X-Proxy-Primary-URL", u1.toString());
    res.set("X-Proxy-Primary-Status", String(r.status));

    if (!r.ok && u2) {
      r = await fetchFn(u2.toString(), { method: "GET", headers: upstreamHeaders(b) });
      body = await r.text();
      res.set("X-Proxy-Upstream", u2.toString());
    } else {
      res.set("X-Proxy-Upstream", u1.toString());
    }

    return res.status(r.status).type(r.headers.get("content-type") || "application/json").send(body);
  } catch (e) {
    console.error("GET /proxy/:id error:", e);
    return res.status(500).json({ error: "Proxy fetch failed", detail: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy listening on :${PORT}`);
});
