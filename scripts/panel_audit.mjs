// panel_audit.mjs — measure the assignment panel, don't squint at it.
//
// Both a diagnostic and a gate, on purpose: it always prints the full geometry
// report, and it also fails when the numbers cross a budget. Squinting at
// screenshots is how "some stuff overlaps and it's messy on the phone" stayed
// unquantified — the answer turned out to be 465px of furniture above a 776px
// phone sheet, leaving 139px of conversation, which no screenshot says out loud.
//
// Opens the panel on a deliberately rich assignment
// (long title, long description, several materials, enrichment) at desktop and
// phone widths and prints what is actually wrong: overlapping boxes, content
// wider than its container, and how much vertical space each band takes before
// the conversation starts.
//
// Usage: BASE_URL=http://localhost:4321 node scripts/panel_audit.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();

const COURSE = { id: "c1", name: "Náuka o podnikaní Y3 3.T", section: "2025/26", creationTime: "2025-07-01T12:31:18.847Z", courseState: "ACTIVE" };
const soon = new Date(Date.now() + 86400000);
const WORK = {
  id: "w1", courseId: "c1",
  title: "Prepare the investor pitch deck and rehearse the five-minute delivery",
  workType: "ASSIGNMENT", state: "PUBLISHED",
  alternateLink: "https://classroom.google.com/c/x/a/y/details",
  creationTime: new Date().toISOString(), updateTime: new Date().toISOString(),
  dueDate: { year: soon.getFullYear(), month: soon.getMonth() + 1, day: soon.getDate() },
  description: "Build a ten-slide deck covering problem, solution, market size, business model, competition, traction, team, financials, the ask and contact.\n\nRehearse until you can deliver it in five minutes without notes. Bring a printed handout for each panel member.",
  materials: [
    { driveFile: { driveFile: { id: "d1", title: "Pitch deck template (2025-26 edition).pptx", alternateLink: "https://drive.google.com/file/d/1" } } },
    { driveFile: { driveFile: { id: "d2", title: "Marking rubric.pdf", alternateLink: "https://drive.google.com/file/d/2" } } },
    { youtubeVideo: { id: "y1", title: "How to pitch: a worked example", alternateLink: "https://youtu.be/x" } },
    { link: { url: "https://example.com/market-sizing", title: "Market sizing primer" } },
  ],
};
const ENRICHMENT = {
  id: "w1",
  oneLineSummary: "Build and rehearse a ten-slide investor pitch, delivered in five minutes to a panel.",
  actionType: "in_person",
  estimatedMinutes: 180,
  taskKind: "Presentation",
};

async function openPanel(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.route("**/api/oauth-config*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ hasRefreshTokens: false }) }));
  await page.route("**/api/chat**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: [] }) }));
  await page.route("**/api/enrich**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enrichments: [ENRICHMENT] }) }));
  await page.route("**/api/**", (r) => r.fulfill({ status: 404, body: "{}" }));
  await page.route("**/accounts.google.com/**", (r) => r.fulfill({ status: 204, body: "" }));
  await page.route("https://classroom.googleapis.com/**", (r) => {
    const url = r.request().url();
    const body = url.includes("/courseWork?") ? { courseWork: [WORK] }
      : url.includes("studentSubmissions") ? { studentSubmissions: [{ courseWorkId: "w1", state: "CREATED" }] }
      : url.includes("/courses?") ? { courses: [COURSE] }
      : {};
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.evaluate(() => new Promise((res, rej) => {
    localStorage.setItem("cwa_user_hint", "student@example.edu");
    const req = indexedDB.open("cwa-archive", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("archive", { keyPath: "id" });
    req.onsuccess = () => {
      const tx = req.result.transaction("archive", "readwrite");
      tx.objectStore("archive").put({ id: "auth-session", token: "test-token", expiresAt: Date.now() + 3600000 });
      tx.oncomplete = () => { req.result.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    req.onerror = () => rej(req.error);
  }));
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector(".assignment", { timeout: 15000 });
  await page.locator(".assignment").first().click();
  await page.waitForSelector("#ai:not([hidden])", { timeout: 5000 });
  await page.waitForTimeout(600);
  return page;
}

// Budgets, not aspirations. Before 2026-09-09 these read 461/465 and 171/191.
const FURNITURE_BUDGET = 340;   // px of panel above the conversation
const GROUNDING_BUDGET = 60;    // px for the "what the tutor sees" line
const failures = [];

const report = async (label, width, height) => {
  const page = await openPanel(width, height);
  const data = await page.evaluate(() => {
    const panel = document.getElementById("ai");
    const named = (el) => el.id ? `#${el.id}` : `.${(el.className || "").toString().split(" ")[0]}`;

    // Boxes that should never share pixels: the panel's own top-level bands,
    // plus anything interactive inside them.
    const bands = [...panel.children].map((el) => ({ name: named(el), r: el.getBoundingClientRect() }));
    const interactive = [...panel.querySelectorAll("a, button, input, summary")]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ name: `${named(el)}[${(el.textContent || "").trim().slice(0, 22)}]`, r: el.getBoundingClientRect() }));

    const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const clashes = [];
    for (let i = 0; i < interactive.length; i++) {
      for (let j = i + 1; j < interactive.length; j++) {
        const overlap = area(interactive[i].r, interactive[j].r);
        if (overlap > 16) clashes.push(`${interactive[i].name} ∩ ${interactive[j].name} = ${Math.round(overlap)}px²`);
      }
    }

    const overflow = [...panel.querySelectorAll("*")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible")
      .map((el) => `${named(el)} content ${el.scrollWidth}px in ${el.clientWidth}px`);

    const ctx = document.getElementById("aiContext");
    return {
      panelHeight: Math.round(panel.getBoundingClientRect().height),
      bands: bands.map((b) => `${b.name}: ${Math.round(b.r.height)}px`),
      beforeConversation: Math.round(document.getElementById("aiMessages").getBoundingClientRect().top - panel.getBoundingClientRect().top),
      contextScrolls: ctx.scrollHeight > ctx.clientHeight + 1 ? `${ctx.scrollHeight}px of content in a ${ctx.clientHeight}px box` : "fits",
      contextBrTags: ctx.querySelectorAll("br").length,
      groundingHeight: Math.round(document.getElementById("aiGroundingBadge").getBoundingClientRect().height),
      clashes,
      overflow,
    };
  });
  console.log(`\n=== ${label} (${width}x${height}) ===`);
  console.log(`panel ${data.panelHeight}px; ${data.beforeConversation}px of furniture before the conversation`);
  console.log("bands:", data.bands.join(", "));
  console.log("context:", data.contextScrolls, `| ${data.contextBrTags} <br> separators`);
  console.log("overlapping controls:", data.clashes.length ? "\n  " + data.clashes.join("\n  ") : "none");
  console.log("overflowing boxes:", data.overflow.length ? "\n  " + data.overflow.join("\n  ") : "none");

  const check = (condition, message) => { if (!condition) failures.push(`${label}: ${message}`); };
  check(data.beforeConversation <= FURNITURE_BUDGET,
    `${data.beforeConversation}px of furniture before the conversation (budget ${FURNITURE_BUDGET}px)`);
  check(data.groundingHeight <= GROUNDING_BUDGET,
    `grounding line is ${data.groundingHeight}px (budget ${GROUNDING_BUDGET}px) — it is a line, not a panel`);
  check(data.contextScrolls === "fits",
    `the context block scrolls inside itself: ${data.contextScrolls}`);
  check(data.contextBrTags === 0,
    `${data.contextBrTags} <br> separators — facts belong in elements, not line breaks`);
  check(data.clashes.length === 0, `overlapping controls: ${data.clashes.join("; ")}`);
  check(data.overflow.length === 0, `content wider than its box: ${data.overflow.join("; ")}`);
  await page.close();
};

try {
  await report("desktop", 1280, 900);
  await report("phone", 390, 844);
} finally {
  await browser.close();
}

if (failures.length) {
  console.error("\nassignment panel FAILED:");
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("\nassignment panel layout passed");
