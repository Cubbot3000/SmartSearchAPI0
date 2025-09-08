import express from "express";
import cors from "cors";
import morgan from "morgan";
import fetch from "node-fetch";

// ---------- Config ----------
const SMARTSEARCH_BASE = process.env.SMARTSEARCH_BASE || "https://api2.smartsearchonline.com/openapi/v1";
const SMARTSEARCH_API_KEY = process.env.SMARTSEARCH_API_KEY;
const SS_USER = process.env.SS_USER;     // service account username
const SS_PASS = process.env.SS_PASS;     // service account password
const PROXY_KEY = process.env.PROXY_KEY; // optional gate
const PORT = process.env.PORT || 10000;

// Expose only chosen GET resources
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

// Some tenants use /job/applicants
const PATH_ALIASES = { applicants: "job/applicants" };

// ---------- App ----------
const app = express();
app.use(cors());
app.use(morgan("tiny"));
app.use(express.json());

// Optional shared-secret gate
app.use((req, res, next) => {
  if (!PROXY_KEY) return next();
  if (req.header("X-Proxy-Key") !== PROXY_KEY) return res.status(401).json({ error: "Bad proxy key" });
  return next();
});

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---------- Bearer cache ----------
let bearer = null;
let bearerExpiresAt = 0; // ms epoch

function parseExpiresIn(value) {
  if (!value) return null;
  if (/^\d+$/.test(String(value))) return Number(value) * 1000; // seconds -> ms
  const d = Date.parse(value);
  if (!Number.isNaN(d)) return d - Date.now();
  return null;
}

async function getBearer() {
  const skew = 120000; // refresh 2 min early
  if (bearer && Date.now() < bearerExpiresAt - skew) return bearer;

  if (!SMARTSEARCH_API_KEY || !SS_USER || !SS_PASS) {
    throw new Error("Missing SMARTSEARCH_API_KEY, SS_USER, or SS_PASS");
  }

  const r = await fetch(`${SMARTSEARCH_BASE}/accounts`, {
    method: "POST",
    headers: {
      "X-API-KEY": SMARTSEARCH_API_KEY,
      "Accept": "application/json;odata.metadata=minimal;odata.streaming=true",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ userName: SS_USER, password: SS_PASS })
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Auth failed ${r.status}: ${text}`);
  }

  const data = await r.json(); // { accessToken, expiresIn, tokenType }
  bearer = data.accessToken;
  const ms = parseExpiresIn(data.expiresIn) ?? 30 * 60 * 1000;
  bearerExpiresAt = Date.now() + ms;
  return bearer;
}

// ---------- Helpers ----------
function buildUrls(resource, id) {
  const p1 = id
    ? `${SMARTSEARCH_BASE}/${resource}/${encodeURIComponent(id)}`
    : `${SMARTSEARCH_BASE}/${resource}`;
  const altBase = PATH_ALIASES[resource];
  const p2 = altBase
    ? (id
        ? `${SMARTSEARCH_BASE}/${altBase}/${encodeURIComponent(id)}`
        : `${SMARTSEARCH_BASE}/${altBase}`)
    : null;
  return [p1, p2];
}

// ---------- Routes ----------
app.get("/proxy/:resource", async (req, res) => {
  const { resource } = req.params;
  if (!ALLOW_LIST.has(resource)) return res.status(404).json({ error: "Resource not allowed" });

  try {
    const b = await getBearer();
    const [u1, u2] = buildUrls(resource, null);
    const url1 = new URL(u1);
    const url2 = u2 ? new URL(u2) : null;
    for (const [k, v] of Object.entries(req.query)) {
      url1.searchParams.set(k, v);
      if (url2) url2.searchParams.set(k, v);
    }

    const headers = {
      "X-API-KEY": SMARTSEARCH_API_KEY,
      "Accept": "application/json;odata.metadata=minimal;odata.streaming=true",
      "Authorization": `Bearer ${b}`
    };

    let r = await fetch(url1.toString(), { method: "GET", headers });
    if (r.status === 404 && url2) {
      r = await fetch(url2.toString(), { method: "GET", headers });
      res.set("X-Proxy-Upstream", url2.toString());
    } else {
      res.set("X-Proxy-Upstream", url1.toString());
    }

    const text = await r.text();
    return res
      .status(r.status)
      .type(r.headers.get("content-type") || "application/json")
      .send(text);
  } catch (e) {
    return res.status(500).json({ error: "Proxy fetch failed", detail: String(e) });
  }
});

app.get("/proxy/:resource/:id", async (req, res) => {
  const { resource, id } = req.params;
  if (!ALLOW_LIST.has(resource)) return res.status(404).json({ error: "Resource not allowed" });

  try {
    const b = await getBearer();
    const [u1, u2] = buildUrls(resource, id);
    const headers = {
      "X-API-KEY": SMARTSEARCH_API_KEY,
      "Accept": "application/json;odata.metadata=minimal;odata.streaming=true",
      "Authorization": `Bearer ${b}`
    };

    let r = await fetch(u1.toString(), { method: "GET", headers });
    if (r.status === 404 && u2) {
      r = await fetch(u2.toString(), { method: "GET", headers });
      res.set("X-Proxy-Upstream", u2.toString());
    } else {
      res.set("X-Proxy-Upstream", u1.toString());
    }

    const text = await r.text();
    return res
      .status(r.status)
      .type(r.headers.get("content-type") || "application/json")
      .send(text);
  } catch (e) {
    return res.status(500).json({ error: "Proxy fetch failed", detail: String(e) });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Proxy listening on :${PORT}`);
});

