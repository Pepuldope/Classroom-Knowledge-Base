// layout_audit.mjs — programmatic layout-robustness audit for the live site.
// Exercises the real-usage states from owner directive #7 and reports
// MEASURABLE defects: horizontal overflow, element overlaps, off-screen
// key elements, modal/viewport fit, related-notes overlap, empty/loading
// states. Returns JSON to stdout. No human aesthetic judgement (that needs
// vision, which is rate-limited) — this catches concrete breakage.
import { chromium } from "playwright";

const URL = process.env.KB_LIVE_URL || "https://classroom-knowledge-google.vercel.app";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defects = [];
const note = (view, state, sev, msg, extra) =>
  defects.push({ view, state, sev, msg, ...(extra || {}) });

function rectOf(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom };
  }, sel);
}
function overlap(a, b) {
  if (!a || !b) return false;
  const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return ix > 4 && iy > 4 ? ix * iy : 0;
}

async function auditViewport(page, vp, tag) {
  const W = vp.width;
  // 1. Planner first paint
  await page.goto(URL, { waitUntil: "networkidle" });
  await sleep(600);
  let ov = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  if (ov.sw > ov.cw + 2) note(tag, "planner", "high", `horizontal overflow: scrollWidth ${ov.sw} > clientWidth ${ov.cw}`);

  // 2. KB landing
  await page.click('[data-view="kb"]');
  await sleep(1500);
  ov = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
    kbMain: !!document.querySelector("#kbMain:not([hidden])"),
    onboard: !!document.querySelector("#kbOnboarding:not([hidden])"),
  }));
  if (ov.sw > ov.cw + 2) note(tag, "kb-landing", "high", `KB horizontal overflow ${ov.sw}>${ov.cw}`);
  note(tag, "kb-landing", "info", `kbMain shown=${ov.kbMain} onboarding shown=${ov.onboard}`);

  // 3. Search results
  await page.fill("#kbSearchInput", "algebra");
  await sleep(1300);
  const resCount = await page.evaluate(() => document.querySelectorAll("#kbResults .kb-result-card").length);
  note(tag, "kb-results", resCount > 0 ? "info" : "high", `result cards=${resCount}`);
  ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (ov > 2) note(tag, "kb-results", "high", `results horizontal overflow +${ov}px`);

  // 4. Filter chips present (course/year) — directive #2
  const chipInfo = await page.evaluate(() => {
    const chips = [...document.querySelectorAll("#kbFilterChips .kb-chip")];
    const labels = [...document.querySelectorAll("#kbFilterChips .kb-chip-group-label")].map((e) => e.textContent);
    return { count: chips.length, labels };
  });
  note(tag, "kb-filters", chipInfo.count > 0 ? "info" : "med", `filter chips=${chipInfo.count} groups=${JSON.stringify(chipInfo.labels)}`);

  // 5. Open first note modal + related-notes overlap (directive #9)
  const card = page.locator("#kbResults .kb-result-card").first();
  if (await card.count()) {
    await card.click();
    await sleep(1000);
    const modal = await rectOf(page, "#kbNoteModal .modal-card");
    const vpSize = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    if (modal) {
      if (modal.bottom > vpSize.h + 1 || modal.top < -1)
        note(tag, "note-modal", "high", `modal overflows viewport: top=${modal.top.toFixed(0)} bottom=${modal.bottom.toFixed(0)} vp=${vpSize.h}`);
      else
        note(tag, "note-modal", "info", `modal fits viewport (${modal.w.toFixed(0)}x${modal.h.toFixed(0)})`);
    } else {
      note(tag, "note-modal", "high", "note modal card not found after click");
    }
    const rel = await rectOf(page, "#kbNoteRelated");
    const body = await rectOf(page, "#kbNoteBody");
    const ov2 = overlap(rel, body);
    if (rel && rel.h > 0 && ov2 > 0)
      note(tag, "note-related", "high", `related-notes overlaps note body by ${Math.round(ov2)}px²`, { rel, body });
    else
      note(tag, "note-related", "info", `related-notes does not overlap body (rel h=${rel ? rel.h.toFixed(0) : "n/a"})`);
    // 6. scroll within modal to bottom
    await page.evaluate(() => { const b = document.querySelector("#kbNoteBody"); if (b) b.scrollTop = b.scrollHeight; });
    await sleep(400);
    await page.click("#kbNoteClose");
    await sleep(300);
  } else {
    note(tag, "note-modal", "high", "no result card to open (search returned nothing)");
  }

  // 7. Tutor modal fit
  await page.click("#kbTutorOpen");
  await sleep(600);
  const tmodal = await rectOf(page, "#kbTutorModal .modal-card");
  const vpSize2 = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  if (tmodal && (tmodal.bottom > vpSize2.h + 1 || tmodal.top < -1))
    note(tag, "tutor-modal", "high", `tutor modal overflows viewport bottom=${tmodal.bottom.toFixed(0)} vp=${vpSize2.h}`);
  else if (tmodal) note(tag, "tutor-modal", "info", "tutor modal fits viewport");
  await page.click("#kbTutorClose");
  await sleep(300);

  // 8. Browse + course folding (directive #11)
  await page.fill("#kbSearchInput", "");
  await sleep(1000);
  const courseCard = page.locator("#kbBrowseCourses .kb-course-card").first();
  if (await courseCard.count()) {
    await courseCard.click();
    await sleep(1200);
    const groups = await page.evaluate(() => document.querySelectorAll("#kbBrowseNotes details").length);
    note(tag, "course-fold", groups > 0 ? "info" : "med", `course groups/accordions=${groups}`);
  } else {
    note(tag, "course-fold", "med", "no course card in browse view");
  }

  // 9. Archive view overflow
  await page.click('[data-view="archive"]');
  await sleep(1200);
  ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (ov > 2) note(tag, "archive", "high", `archive horizontal overflow +${ov}px`);
  else note(tag, "archive", "info", "archive no overflow");
}

async function main() {
  const browser = await chromium.launch();
  const ctxD = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true });
  await auditViewport(await ctxD.newPage(), { width: 1280 }, "DESKTOP");
  await auditViewport(await ctxM.newPage(), { width: 390 }, "MOBILE");
  await browser.close();
  const highs = defects.filter((d) => d.sev === "high");
  const meds = defects.filter((d) => d.sev === "med");
  const infos = defects.filter((d) => d.sev === "info");
  console.log(JSON.stringify({ summary: { high: highs.length, med: meds.length, info: infos.length }, defects }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
