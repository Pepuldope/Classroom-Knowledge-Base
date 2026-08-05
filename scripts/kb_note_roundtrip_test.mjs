// Warm local round-trip smoke: opening and closing a private note must return
// focus to the same result card without falling back to a server note request.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { summarizeWarmTransitionSamples } from "../kb-transition-timing.js";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
let legacyNoteRequests = 0;
page.on("pageerror", (error) => pageErrors.push(String(error)));
page.on("request", (request) => {
  if (request.url().includes("/api/kb-note")) legacyNoteRequests += 1;
});

try {
  const response = await page.goto(`${BASE}/kb-test-harness.html`, { waitUntil: "networkidle", timeout: 30000 });
  assert.ok(response?.ok(), `KB harness should load (HTTP ${response?.status()})`);
  await page.evaluate(async () => {
    const { saveKbBundle } = await import("/kb-local.js");
    await saveKbBundle({
      version: 1,
      source: "classroom",
      generatedAt: new Date().toISOString(),
      years: ["2026"],
      courses: ["Local course"],
      notes: [
        { t: "Local round-trip note", course: "Local course", y: "2026", topic: "Warm path", s: "A local summary", x: "A local note body", p: "local.md" },
        { t: "Second local note", course: "Local course", y: "2026", topic: "Warm path", s: "Another summary", x: "Another body", p: "second.md" },
      ],
    });
  });
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll("#kbResults .kb-result-card").length > 0 || document.querySelector("#kbMain:not([hidden])"));
  await page.locator("#kbSearchInput").fill("local");
  await page.waitForSelector("#kbResults .kb-result-card", { timeout: 10000 });
  const card = page.locator("#kbResults .kb-result-card").first();
  const cardId = await card.getAttribute("id");
  assert.ok(cardId, "result card must expose a stable local note id");

  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    const elapsed = await page.evaluate(async (id) => {
      const card = document.getElementById(id);
      const modal = document.getElementById("kbNoteModal");
      const close = document.getElementById("kbNoteClose");
      if (!card || !modal || !close) throw new Error("round-trip controls are missing");
      card.focus();
      card.click();
      const openDeadline = performance.now() + 2000;
      while (modal.hidden && performance.now() < openDeadline) await new Promise((resolve) => requestAnimationFrame(resolve));
      if (modal.hidden) throw new Error("note modal did not open");
      const started = performance.now();
      close.click();
      const closeDeadline = started + 1000;
      while ((!modal.hidden || document.activeElement?.id !== id) && performance.now() < closeDeadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      if (!modal.hidden || document.activeElement?.id !== id) throw new Error("note modal did not return focus");
      return performance.now() - started;
    }, cardId);
    samples.push(elapsed);
  }

  const summary = summarizeWarmTransitionSamples(samples);
  assert.equal(legacyNoteRequests, 0, "local note round-trips must not call the legacy note route");
  assert.equal(summary.withinBudget, true, `warm KB note round-trip exceeded 100ms p95: ${JSON.stringify(summary)}`);
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
  console.log(`✓ warm local KB note round-trip returned focus to ${cardId} (p95 ${summary.p95Ms.toFixed(2)}ms, ${BASE})`);
} finally {
  await browser.close();
}
