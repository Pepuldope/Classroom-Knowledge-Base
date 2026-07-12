// seed-dev.mjs — parse a slice of the REAL vault and POST it to the local
// dev server's /api/kb-scrape so the KB has data to search/show visually.
import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

const VAULT = "/opt/data/school-backup";
const PORT = Number(process.argv[2] || 4321);
const LIMIT = Number(process.argv[3] || 400); // how many notes to seed

// kb-scrape.js requires write auth for EVERY source (the security commit
// a9d4b89 added requireWriteAuth across all paths, including `source:"bundle"`).
// The dev server loads KB_WRITE_TOKEN from the same env file below; this script
// runs as a SEPARATE process, so load it here or the seed will 401 and leave
// the in-memory DB empty (which makes every UI e2e interaction time out).
function loadWriteToken() {
  if (process.env.KB_WRITE_TOKEN) return process.env.KB_WRITE_TOKEN;
  try {
    const txt = readFileSync("/opt/data/.hermes/.env", "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^KB_WRITE_TOKEN=(.+)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return "";
}
const KB_WRITE_TOKEN = loadWriteToken();

function parseObsidian(content) {
  const lines = content.split("\n");
  let i = 0;
  const front = {};
  if (lines[0]?.trim() === "---") {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === "---") { i = j + 1; break; }
      const m = lines[j].match(/^([A-Za-z0-9_ ]+):\s*(.*)$/);
      if (m) front[m[1].trim()] = m[2].trim();
    }
  }
  const title = (front.title || front["display-title"] || lines[i]?.replace(/^#\s*/, "").trim() || "Untitled").trim();
  const body = lines.slice(i).join("\n").trim();
  const h2 = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
  const sections = {};
  let cur = null;
  for (const ln of body.split("\n")) {
    const m = ln.match(/^##\s+(.+)$/);
    if (m) { cur = m[1].trim(); sections[cur] = ""; }
    else if (cur) sections[cur] += ln + "\n";
  }
  return { title, body, sections, topics: h2 };
}

async function walk(dir, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) await walk(fp, acc);
    else if (e.name.endsWith(".md")) acc.push(fp);
  }
  return acc;
}

const files = (await walk(VAULT)).slice(0, LIMIT);
const notes = [];
for (const fp of files) {
  const txt = await readFile(fp, "utf8");
  const { title, body, sections, topics } = parseObsidian(txt);
  const rel = path.relative(VAULT, fp);
  const parts = rel.split(path.sep);
  // Structure: <year>/vault/<course>/...  OR  <year>/<course>/...  OR top-level
  const yearMatch = parts.find((p) => /^20\d\d-\d\d$/.test(p));
  const year = yearMatch || "";
  let course = "";
  const vi = parts.indexOf("vault");
  if (vi >= 0 && parts[vi + 1]) course = parts[vi + 1];
  else if (parts.length >= 2) course = parts[1];
  // Sanitize: course must look like a folder, not a loose .md file or index.
  if (!course || course.endsWith(".md") || /^00 /.test(course)) course = "";
  notes.push({
    t: title, s: body, x: body, f: rel, w: body.split(/\s+/).length,
    topic: topics[0] || "", course, y: year, sec: sections,
  });
}
const years = [...new Set(notes.map((n) => n.y).filter(Boolean))].sort();
const courses = [...new Set(notes.map((n) => n.course).filter(Boolean))].sort();

const bundle = {
  version: 1,
  source: "bundle",
  generatedAt: new Date().toISOString(),
  notes, years, courses,
  metadata: { years, courses, total: notes.length },
};

const res = await fetch(`http://localhost:${PORT}/api/kb-scrape`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-KB-Write-Token": KB_WRITE_TOKEN },
  body: JSON.stringify({ source: "bundle", bundle }),
});
console.log("scrape status:", res.status);
console.log("seeded notes:", notes.length, "| years:", years.length, "| courses:", courses.length);
