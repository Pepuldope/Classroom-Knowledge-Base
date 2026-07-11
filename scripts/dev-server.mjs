// dev-server.mjs — local harness to visually test the Classroom Knowledge Base
// site WITHOUT Vercel. Serves static frontend (index.html, app.js, kb.js,
// styles.css) and mounts the api/ handlers as in-process Edge-style functions.
//
// Only the endpoints the frontend actually needs for the KB flow are wired:
//   GET  /api/kb-search
//   POST /api/kb-scrape
//   GET  /api/oauth-config
//   POST /api/tutor
// Others return 501 so we know they're not part of the test scope.
//
// Usage: node dev-server.mjs [port]   (default 4321)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 4321);

// Load OPENROUTER_API_KEY + KV-less (in-memory) env from the editable env surface.
try {
  const envTxt = await readFile("/opt/data/.hermes/.env", "utf8");
  for (const line of envTxt.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {}

// Import the handlers.
const kbSearch = (await import("../api/kb-search.js")).default;
const kbScrape = (await import("../api/kb-scrape.js")).default;
const oauthConfig = (await import("../api/oauth-config.js")).default;
const tutor = (await import("../api/tutor.js")).default;

const STATIC = {
  "/": "../index.html",
  "/index.html": "../index.html",
  "/app.js": "../app.js",
  "/kb.js": "../kb.js",
  "/kb-highlight.js": "../kb-highlight.js",
  "/styles.css": "../styles.css",
};
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // --- API routes ---
  if (p === "/api/kb-search") return await runHandler(kbSearch, req, res, url);
  if (p === "/api/kb-scrape") return await runHandler(kbScrape, req, res, url);
  if (p === "/api/oauth-config") return await runHandler(oauthConfig, req, res, url);
  if (p === "/api/tutor") return await runHandler(tutor, req, res, url);
  if (p.startsWith("/api/")) {
    res.writeHead(501, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "not wired in dev harness" }));
  }

  // --- Static ---
  const rel = STATIC[p] || (p.startsWith("/api") ? null : p.replace(/^\//, ""));
  if (!rel) { res.writeHead(404); return res.end("not found"); }
  const fp = path.join(__dirname, rel);
  if (!existsSync(fp)) { res.writeHead(404); return res.end("not found"); }
  const buf = await readFile(fp);
  res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
  res.end(buf);
});

async function runHandler(handler, req, res, url) {
  // Build an Edge-like Request object.
  let body = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
  }
  const absoluteUrl = url.toString(); // already absolute (http://localhost:PORT/...)
  const request = new Request(absoluteUrl, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" ? undefined : JSON.stringify(body),
  });
  const response = await handler(request);
  const r = response instanceof Response ? response : new Response(response.body || "", response);
  const headers = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(r.status, headers);
  const ab = await r.arrayBuffer();
  res.end(Buffer.from(ab));
}

server.listen(PORT, () => console.log(`KB dev server on http://localhost:${PORT}`));
