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

// Whitelist and seed aliases
const ALLOW_LIST = new Set([
  "applicants","businesses","candidates","contacts","documents","hires","jobs","notes","offers","projects"
]);
// initial guesses; discovery will add more dynamically
const PATH_ALIASES = { applicants: "job/applicants" };

const app = express();
app.use(cors());
app.use(morgan("tiny"));
app.use(express.json());

// Optional shared secret
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
  if (/^\d+$/.test(String(value))) return Number(value) * 1000;
  const d = Date.parse(value);
  return Number.isNaN(d) ? null : (d - Date.now());
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

async function getBearer() {
  const skew = 120000;
  if (bearer && Date.now() < bearerExpiresAt - skew) return bearer;
  if (!SMARTSEARCH_API_KEY || !SS_USER || !SS_PASS) throw new Error("Missing SMARTSEARCH_API_KEY or SS_USER or SS_PASS");

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

function buildCandidateList(resource, id, discovered=[]) {
  // hard-coded guesses
  const base = [
    `${resource}`,
    `job/${resource}`,
    resource === "applicants" ? "job/applications" : null,
    resource === "applicants" ? "applications" : null,
    resource === "applicants" ? "JobApplicants" : null,
    resource === "applicants" ? "job/JobApplicants" : null,
    resource === "applicants" ? "jobapplications" : null,
    resource === "applicants" ? "JobApplications" : null
  ].filter(Boolean);

  // discovered entity sets appended (unique)
  const extra = (discovered || []).filter(Boolean);
  const seen = new Set();
  const rels = [...base, ...extra].filter(p => {
    const rel = id ? `${p}/${encodeURIComponent(id)}` : p;
    if (seen.has(rel)) return false;
    seen.add(rel);
    return true;
  });

  // convert to absolute URLs
  return rels.map(rel => `${SMARTSEARCH_BASE}/${rel}`);
}

// ---- OData discovery (via $metadata and service root) ----
async function discoverEntitySets(patterns) {
  const b = await getBearer();

  // $metadata
  let metaText = "";
  try {
    const r = await fetchFn(`${SMARTSEARCH_BASE}/$metadata`, {
      headers: {
        "X-API-KEY": SMARTSEARCH_API_KEY,
        "Accept": "application/xml,text/xml,application/json",
        "Authorization": `Bearer ${b}`
      }
    });
    metaText = await r.text();
  } catch (_) { /* ignore */ }

  const discovered = new Set();

  if (metaText) {
    for (const pat of patterns) {
      const re = new RegExp(`<EntitySet\\s+Name="([^"]*${pat}[^"]*)"`, "gi");
      let m;
      while ((m = re.exec(metaText)) !== null) {
        discovered.add(m[1]);
      }
    }
  }

  // Service document (may list entity sets as JSON)
  try {
    const r2 = await fetchFn(`${SMARTSEARCH_BASE}/`, {
      headers: {
        "X-API-KEY": SMARTSEARCH_API_KEY,
        "Accept": "application/json",
        "Authorization": `Bearer ${b}`
      }
    });
    if (r2.ok) {
      const svc = await r2.json().catch(() => ({}));
      const col = Array.isArray(svc?.value) ? svc.value : [];
      for (const it of col) {
        const name = it?.name || it?.title;
        if (typeof name === "string") {
          for (const pat of patterns) {
            if (name.toLowerCase().includes(pat.toLowerCase())) discovered.add(name);
          }
        }
      }
    }
  } catch (_) { /* ignore */ }

  return Array.from(discovered);
}

// ---- Debug endpoints ----
app.get("/debug/auth", async (_req, res) => {
  try {
    const b = await getBearer();
    res.json({ ok: true, bearerPreview: b.slice(0, 8) + "...", expiresAt: new Date(bearerExpiresAt).toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/debug/metadata", async (_req, res) => {
  try {
    const b = await getBearer();
    const r = await fetchFn(`${SMARTSEARCH_BASE}/$metadata`, {
      headers: { "X-API-KEY": SMARTSEARCH_API_KEY, "Authorization": `Bearer ${b}` }
    });
    const t = await r.text();
    res.status(r.status).type(r.headers.get("content-type") || "application/xml").send(t);
  } catch (e) {
    res.status(500).json({ error: "Fetch metadata failed", detail: String(e) });
  }
});

app.get("/debug/service", async (_req, res) => {
  try {
    const b = await getBearer();
    const r = await fetchFn(`${SMARTSEARCH_BASE}/`, {
      headers: { "X-API-KEY": SMARTSEARCH_API_KEY, "Authorization": `Bearer ${b}`, "Accept": "application/json" }
    });
    const t = await r.text();
    res.status(r.status).type(r.headers.get("content-type") || "application/json").send(t);
  } catch (e) {
    res.status(500).json({ error: "Fetch service doc failed", detail: String(e) });
  }
});

// ----- GET collection with discovery + fallback -----
app.get("/proxy/:resource", async (req, res) => {
  try {
    const { resource } = req.params;
    if (!ALLOW_LIST.has(resource)) return res.status(404).json({ error: "Resource not allowed" });

    const b = await getBearer();

    // build discovery list for applicants
    let discovered = [];
    if (resource === "applicants") {
      discovered = await discoverEntitySets(["Applicant", "Application"]);
    }

    // candidates list of absolute URLs
    const attempts = buildCandidateList(resource, null, discovered);

    // propagate OData query to each URL
    const qryPairs = Object.entries(req.query);
    for (let i = 0; i < attempts.length; i++) {
      const u = new URL(attempts[i]);
      for (const [k, v] of qryPairs) u.searchParams.set(k, v);
      attempts[i] = u.toString();
    }

    const tryLog = [];
    let finalResp = null;
    for (const u of attempts) {
      const r = await fetchFn(u, { method: "GET", headers: upstreamHeaders(b) });
      const body = await r.text();
      tryLog.push(`${r.status}@${u.replace(SMARTSEARCH_BASE, "")}`);
      if (r.ok) {
        res.set("X-Proxy-Upstream", u);
        res.set("X-Proxy-Attempts", tryLog.join("|"));
        return res.status(r.status).type(r.headers.get("content-type") || "application/json").send(body);
      }
      finalResp = { status: r.status, body, ctype: r.headers.get("content-type") };
      // keep looping to next candidate
    }

    res.set("X-Proxy-Attempts", tryLog.join("|"));
    if (finalResp) {
      return res.status(finalResp.status).type(finalResp.ctype || "application/json").send(finalResp.body || "");
    }
    return res.status(404).json({ error: "No upstream matched" });
  } catch (e) {
    console.error("GET /proxy error:", e);
    return res.status(500).json({ error: "Proxy fetch failed", detail: String(e) });
  }
});

// ----- GET by id with discovery + fallback -----
app.get("/proxy/:resource/:id", async (req, res) => {
  try {
    const { resource, id } = req.params;
    if (!ALLOW_LIST.has(resource)) return res.status(404).json({ error: "Resource not allowed" });

    const b = await getBearer();

    let discovered = [];
    if (resource === "applicants") {
      discovered = await discoverEntitySets(["Applicant", "Application"]);
    }

    const attempts = buildCandidateList(resource, id, discovered);
    const tryLog = [];
    let finalResp = null;

    for (const u of attempts) {
      const r = await fetchFn(u, { method: "GET", headers: upstreamHeaders(b) });
      const body = await r.text();
      tryLog.push(`${r.status}@${u.replace(SMARTSEARCH_BASE, "")}`);
      if (r.ok) {
        res.set("X-Proxy-Upstream", u);
        res.set("X-Proxy-Attempts", tryLog.join("|"));
        return res.status(r.status).type(r.headers.get("content-type") || "application/json").send(body);
      }
      finalResp = { status: r.status, body, ctype: r.headers.get("content-type") };
    }

    res.set("X-Proxy-Attempts", tryLog.join("|"));
    if (finalResp) {
      return res.status(finalResp.status).type(finalResp.ctype || "application/json").send(finalResp.body || "");
    }
    return res.status(404).json({ error: "No upstream matched" });
  } catch (e) {
    console.error("GET /proxy/:id error:", e);
    return res.status(500).json({ error: "Proxy fetch failed", detail: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy listening on :${PORT}`);
});
