// seed-vault.mjs — walk a local vault of markdown notes, build raw KB notes,
// and POST them to /api/kb-scrape { source:'vault', notes:[...] }.
//
// WHY: Vercel's Edge runtime forbids node:fs, so the KB cannot read the vault
// at runtime. The walk runs HERE (on a machine with the files) and ships the
// notes to the server, which synthesizes the normalized bundle.
//
// Usage:
//   node scripts/seed-vault.mjs [target] [limit]
//     target = "live"   -> POST to $KB_LIVE_URL (default https://classroom-knowledge-google.vercel.app)
//     target = a port   -> POST to http://localhost:<port>  (local dev server)
//     limit  = max notes to seed (default 3000)
//
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const VAULT = process.env.VAULT_DIR || "/opt/data/school-backup";
const TARGET = process.argv[2] || "live";
const LIMIT = Number(process.argv[3] || 3000);

const LIVE = process.env.KB_LIVE_URL || "https://classroom-knowledge-google.vercel.app";
const BASE = TARGET === "live" ? LIVE : `http://localhost:${TARGET}`;

function parseObsidian(content, rel) {
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
  const parts = rel.split(path.sep);
  const yearMatch = parts.find((p) => /^20\d\d-\d\d$/.test(p));
  const year = yearMatch || "";
  let course = "";
  const vi = parts.indexOf("vault");
  if (vi >= 0 && parts[vi + 1]) course = parts[vi + 1];
  else if (parts.length >= 2) course = parts[1];
  if (!course || course.endsWith(".md") || /^00 /.test(course)) course = "";
  return {
    t: title,
    x: body,
    course,
    y: year,
    topic: h2[0] || "",
    p: rel,
  };
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
  notes.push(parseObsidian(txt, path.relative(VAULT, fp)));
}

const res = await fetch(`${BASE}/api/kb-scrape`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    source: "vault",
    notes,
    meta: { seededFrom: VAULT, total: notes.length },
  }),
});
const json = await res.json().catch(() => ({}));
console.log("scrape status:", res.status);
console.log("response:", JSON.stringify(json));
if (res.ok) {
  console.log(`Seeded ${notes.length} notes into ${BASE} (courses: ${json?.meta?.courses}, years: ${json?.meta?.years?.length}).`);
} else {
  console.error("Seed FAILED — KB still non-functional on", BASE);
  process.exit(1);
}
