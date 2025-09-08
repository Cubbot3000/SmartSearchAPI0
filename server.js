import express from "express";
import cors from "cors";
import morgan from "morgan";
import { fetch as undiciFetch } from "undici";

const fetchFn = globalThis.fetch ?? undiciFetch;

// ----- Config -----
const SMARTSEARCH_BASE = process.env.SMARTSEARCH_BASE || "https://api2.smartsearchonline.com/openapi/v1";
const SMARTSEARCH_API_KEY = process.env.SMARTSEARCH_API_KEY;
const SS_USER = process.env.SS_USER;
const SS_PASS = process.env.SS_PASS;
const PROXY_KEY = process.env.PROXY_KEY;
const PORT = process.env.PORT || 10000;

// Whitelist
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

// Candidate upstream paths for each logical resource (order matters)
const PATH_FALLBACKS = {
  applicants: [
    "applicants",
    "job/applicants",
    "job/applications",
    "applications",
    "JobApplicants",
    "job/JobApplicants",
    "jobapplications"
  ]
};

// ----- App -----
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

function upstreamHeaders(b) {
  return {
    "X-API-KEY": SMARTSEARCH_API_KEY,
    "Accept": "application/json;odata.metadata=minimal;odata.streaming=true",
    "Authorization": `Bearer ${b}`
  };
}

// Build candidate URLs for a logical resource
function buildCandidateUrls(resource, id) {
  const candidates = PATH_FALLBACKS[resource] || [resource];
  return candidates.map(p => {
    const base = id ? `${SMARTSEARCH_BASE}/${p}/${encodeURIComponent(id)}` : `${SMARTSEARCH_BASE}/${p}`;
    return new URL(base);
  });
}

// Try each candidate URL until one returns 2xx
async function tryCandidates(urls, headers, queryObj) {
  const statuses = [];
  let last = null;

  for (const u of urls) {
    // copy query params for each attempt
    if (queryObj) {
      for (const [k, v] of Object.entries(queryObj)) u.searchParams.set(k, v);
    }
    const r = await fetchFn(u.toString(), { method: "GET", headers });
    const body = await r.text();
    statuses.push(`${r.status}@${u.pathname}`);
    if (r.ok) {
      return { ok: true, url: u.toString(), status: r.status, body, contentType: r.headers.get("content-type") };
    }
    last = { url: u.toString(), status: r.status, body, contentType: r.headers.get("content-type") };
  }
  return { ok: false, statuses, last };
}

// ---- Debug: auth
app.get("/debug/auth", async (_req, res) => {
  try {
    const b = await getBearer();
    res.json({ ok: true, bearerPreview: b.slice(0, 8) + "...", expiresAt: new Date(bearerExpiresAt).toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---- Debug: service document (entity sets)
app.get("/debug/service", async (_req, res) => {
  try {
    const b = await getBearer();
    const r = await fetchFn(`${SMARTSEARCH_BASE}/`, { headers: upstreamHeaders(b) });
    const t = await r.text();
    res.status(r.status).type(r.headers.get("content-type") || "application/json").send(t);
  } catch (e) {
    res.status(500).json({ error: "Service doc fetch failed", detail: String(e) });
  }
});

// ---- Debug: metadata (EDMX)
app.get("/debug/metadata", async (_req, res) => {
  try {
    const b = await getBearer();
    const r = await fetchFn(`${SMARTSEARCH_BASE}/$metadata`, {
      headers: { ...upstreamHeaders(b), Accept: "application/xml" }
    });
    const t = await r.text();
    res.status(r.status).type(r.headers.get("content-type") || "application/xml").send(t);
  } catch (e) {
    res.status(500).json({ error: "Metadata fetch failed", detail: String(e) });
  }
});

// ----- GET collection with multi-path fallback -----
app.get("/proxy/:resource", async (req, res) => {
  try {
    const { resource } = req.params;
    if (!ALLOW_LIST.has(resource)) return res.status(404).json({ error: "Resource not allowed" });

    const b = await getBearer();
    const urls = buildCandidateUrls(resource, null);
    const result = await tryCandidates(urls, upstreamHeaders(b), req.query);

    res.set("X-Proxy-Candidates", urls.map(u => u.pathname).join(","));
    if (result.ok) {
      res.set("X-Proxy-Upstream", result.url);
      return res.status(result.status).type(result.contentType || "application/json").send(result.body);
    } else {
      res.set("X-Proxy-Attempts", (result.statuses || []).join("|"));
      res.set("X-Proxy-Upstream", result.last?.url || "");
      return res.status(result.last?.status || 502).type(result.last?.contentType || "application/json").send(result.last?.body || "");
    }
  } catch (e) {
    console.error("GET /proxy error:", e);
    return res.status(500).json({ error: "Proxy fetch failed", detail: String(e) });
  }
});

// ----- GET by id with multi-path fallback -----
app.get("/proxy/:resource/:id", async (req, res) => {
  try {
    const { resource, id } = req.params;
    if (!ALLOW_LIST.has(resource)) return res.status(404).json({ error: "Resource not allowed" });

    const b = await getBearer();
    const urls = buildCandidateUrls(resource, id);
    const result = await tryCandidates(urls, upstreamHeaders(b));

    res.set("X-Proxy-Candidates", urls.map(u => u.pathname).join(","));
    if (result.ok) {
      res.set("X-Proxy-Upstream", result.url);
      return res.status(result.status).type(result.contentType || "application/json").send(result.body);
    } else {
      res.set("X-Proxy-Attempts", (result.statuses || []).join("|"));
      res.set("X-Proxy-Upstream", result.last?.url || "");
      return res.status(result.last?.status || 502).type(result.last?.contentType || "application/json").send(result.last?.body || "");
    }
  } catch (e) {
    console.error("GET /proxy/:id error:", e);
    return res.status(500).json({ error: "Proxy fetch failed", detail: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy listening on :${PORT}`);
});
