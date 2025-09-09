// server.js
import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// --- Config from env ---
const API_BASE = process.env.API_BASE || "https://api2.smartsearchonline.com/openapi/v1";
const API_KEY  = process.env.API_KEY;       // SmartSearch X-API-KEY (for /accounts only)
const USERNAME = process.env.SS_USERNAME;   // SmartSearch username
const PASSWORD = process.env.SS_PASSWORD;   // SmartSearch password

let token = null;
let tokenExp = 0; // ms epoch

function acceptHeaders(extra = {}) {
  return {
    Accept: "application/json;odata.metadata=minimal;odata.streaming=true",
    ...extra,
  };
}

async function login() {
  const url = `${API_BASE}/accounts`;
  const headers = {
    "X-API-KEY": API_KEY,
    "Content-Type": "application/json",
    ...acceptHeaders(),
  };
  const { data } = await axios.post(
    url,
    { userName: USERNAME, password: PASSWORD },
    { headers }
  );
  token = data.accessToken;
  tokenExp = Date.parse(data.expiresIn || "") || Date.now() + 50 * 60 * 1000; // fallback 50m
  console.log("Obtained token expiring at", new Date(tokenExp).toISOString());
}

async function ensureToken() {
  if (!token || Date.now() > tokenExp - 60_000) {
    console.log("Refreshing token…");
    await login();
  }
}

// Keep $ in OData params like $top, $filter.
const paramsSerializer = {
  serialize: (params) =>
    new URLSearchParams(params).toString().replace(/%24/g, "$"),
};

// CORS (optional)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health
app.get("/health", (_, res) => res.json({ ok: true }));

// Manual auth sanity check
app.post("/proxy/accounts", async (_req, res) => {
  try {
    await login();
    res.json({ token, tokenExp });
  } catch (e) {
    console.error("Auth error:", e.response?.data || e.message);
    res.status(e.response?.status || 500).send(e.response?.data || String(e));
  }
});

// Applicants list
app.get("/proxy/applicants", async (req, res) => {
  try {
    await ensureToken();
    const url = `${API_BASE}/applicants`; // correct path
    const headers = acceptHeaders({ Authorization: `Bearer ${token}` });
    const { data, status, headers: h } = await axios.get(url, {
      headers,
      params: req.query,
      paramsSerializer,
    });
    res
      .status(status)
      .set("Content-Type", h["content-type"] || "application/json")
      .send(data);
  } catch (e) {
    console.error("Applicants error:", e.response?.data || e.message);
    res.status(e.response?.status || 500).send(e.response?.data || String(e));
  }
});

// Applicants “by id” via OData filter
app.get("/proxy/applicants/:idNum", async (req, res) => {
  try {
    await ensureToken();
    const idNum = Number(req.params.idNum);
    if (!Number.isFinite(idNum)) return res.status(400).send("idNum must be a number");
    const url = `${API_BASE}/applicants`;
    const headers = acceptHeaders({ Authorization: `Bearer ${token}` });
    const params = { $filter: `idNum eq ${idNum}` };
    const { data, status, headers: h } = await axios.get(url, {
      headers,
      params,
      paramsSerializer,
    });
    res
      .status(status)
      .set("Content-Type", h["content-type"] || "application/json")
      .send(data);
  } catch (e) {
    console.error("Applicant by id error:", e.response?.data || e.message);
    res.status(e.response?.status || 500).send(e.response?.data || String(e));
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));
