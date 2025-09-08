// server.js
// Node ESM (package.json should have: { "type": "module" })

import express from "express";
import cors from "cors";
import morgan from "morgan";
import fetch from "node-fetch";

// ---------- Config ----------
const SMARTSEARCH_BASE =
  process.env.SMARTSEARCH_BASE || "https://api2.smartsearchonline.com/openapi/v1";
const SMARTSEARCH_API_KEY = process.env.SMARTSEARCH_API_KEY; // required
const SS_USER = process.env.SS_USER;   // required: service username
const SS_PASS = process.env.SS_PASS;   // required: service password
const PROXY_KEY = process.env.PROXY_KEY; // optional: gate this proxy
const PORT = process.env.PORT || 10000;

// Whitelist GET resources you want to expose
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

// Map friendly resources to upstream paths when a tenant uses different routes
const PATH_ALIASES = {
  applicants: "job/applicants"
};

// ---------- App ----------
const app = express();
app.use(cors());
app.
