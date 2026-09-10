// panel_audit.mjs — measure the assignment panel, don't squint at it.
//
// Both a diagnostic and a gate, on purpose: it always prints the full geometry
// report, and it also fails when the numbers cross a budget. Squinting at
// screenshots is how "some stuff overlaps and it's messy on the phone" stayed
// unquantified — the answer turned out to be 465px of furniture above a 776px
// phone sheet, leaving 139px of conversation, which no screenshot says out loud.
//
// Usage: BASE_URL=http://localhost:4321 node scripts/panel_audit.mjs
import { chromium } from "playwright";
import {
  openSignedInPage, overlappingControls, overflowingBoxes, bandHeights, spaceAbove,
} from "./lib/harness.mjs";

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

// Budgets, not aspirations. Before 2026-09-09 these read 461/465 and 171/191.
const FURNITURE_BUDGET = 340;   // px of panel above the conversation
const GROUNDING_BUDGET = 60;    // px for the "what the tutor sees" line
const failures = [];

const report = async (label, viewport) => {
  const { page, errors } = await openSignedInPage(browser, {
    viewport,
    courses: [COURSE],
    courseWork: [WORK],
    submissions: [{ courseWorkId: "w1", state: "CREATED" }],
    enrichments: [ENRICHMENT],
  });
  await page.waitForSelector(".assignment", { timeout: 15000 });
  await page.locator(".assignment").first().click();
  await page.waitForSelector("#ai:not([hidden])", { timeout: 5000 });
  await page.waitForTimeout(600);

  const [bands, clashes, overflow, furniture] = await Promise.all([
    bandHeights(page, "#ai"),
    overlappingControls(page, "#ai"),
    overflowingBoxes(page, "#ai"),
    spaceAbove(page, "#ai", "#aiMessages"),
  ]);
  const detail = await page.evaluate(() => {
    const ctx = document.getElementById("aiContext");
    return {
      panelHeight: Math.round(document.getElementById("ai").getBoundingClientRect().height),
      groundingHeight: Math.round(document.getElementById("aiGroundingBadge").getBoundingClientRect().height),
      contextScrolls: ctx.scrollHeight > ctx.clientHeight + 1
        ? `${ctx.scrollHeight}px of content in a ${ctx.clientHeight}px box` : "fits",
      contextBrTags: ctx.querySelectorAll("br").length,
      postedText: (ctx.querySelector(".ai-posted")?.textContent || "").trim(),
    };
  });

  console.log(`\n=== ${label} (${viewport.width}x${viewport.height}) ===`);
  console.log(`panel ${detail.panelHeight}px; ${furniture}px of furniture before the conversation`);
  console.log("bands:", bands.map((b) => `${b.name}: ${b.height}px`).join(", "));
  console.log("context:", detail.contextScrolls, `| ${detail.contextBrTags} <br> separators | ${detail.postedText || "NO POSTED LINE"}`);
  console.log("overlapping controls:", clashes.length ? "\n  " + clashes.join("\n  ") : "none");
  console.log("overflowing boxes:", overflow.length ? "\n  " + overflow.join("\n  ") : "none");

  const check = (condition, message) => { if (!condition) failures.push(`${label}: ${message}`); };
  check(furniture <= FURNITURE_BUDGET,
    `${furniture}px of furniture before the conversation (budget ${FURNITURE_BUDGET}px)`);
  check(detail.groundingHeight <= GROUNDING_BUDGET,
    `grounding line is ${detail.groundingHeight}px (budget ${GROUNDING_BUDGET}px) — it is a line, not a panel`);
  check(detail.contextScrolls === "fits", `the context block scrolls inside itself: ${detail.contextScrolls}`);
  // Requested 2026-09-10: the panel never said when the thing went up, which
  // is the fact you want when deciding whether you have already seen it.
  // Loose on purpose: the date itself is the reader's locale ("10 Sep 2026",
  // "Sep 10, 2026"), and pinning the format here would fail on a machine set
  // to anything but the CI's locale.
  check(/^Posted .*\d{4}/.test(detail.postedText),
    `the panel does not say when this was posted (got "${detail.postedText}")`);
  check(detail.contextBrTags === 0,
    `${detail.contextBrTags} <br> separators — facts belong in elements, not line breaks`);
  check(clashes.length === 0, `overlapping controls: ${clashes.join("; ")}`);
  check(overflow.length === 0, `content wider than its box: ${overflow.join("; ")}`);
  check(errors.length === 0, `uncaught page errors: ${errors.join(" | ")}`);
  await page.close();
};

try {
  await report("desktop", { width: 1280, height: 900 });
  await report("phone", { width: 390, height: 844 });
} finally {
  await browser.close();
}

if (failures.length) {
  console.error("\nassignment panel FAILED:");
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("\nassignment panel layout passed");
