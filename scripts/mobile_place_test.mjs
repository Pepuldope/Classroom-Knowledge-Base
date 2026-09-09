// mobile_place_test.mjs — six phone defects reported by Pepuldo, 2026-09-09.
//
// All six are the same kind of fault: something that behaves correctly at
// 1280px and not on the device the site is actually read on.
//
//   1. a reload (i.e. an accidental pull-to-refresh) threw the reader back to
//      the Planner, on Search, at the top;
//   2. the Study stat bar wrapped onto two lines;
//   3. the facet chips were ~60 chips on one horizontally-scrolling row;
//   4. the sheet's grab handle was a `pointer-events: none` pseudo-element;
//   5. the phone's own bottom bar covered the sheet's last row of buttons.
//
// (The sixth — the search box being scrolled to the bottom of the screen when
// the keyboard opens — is a `scroll-margin-top` plus a scrollIntoView that only
// a real on-screen keyboard exercises, so what is asserted here is that the
// margin exists and clears the sticky header.)
//
// Usage: BASE_URL=http://localhost:4321 node scripts/mobile_place_test.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";

const note = (course, y, topic, title) => ({
  p: `${y}/${course}/${topic}/${title}`.replace(/\s+/g, "-"),
  t: title, course, y, topic, kind: "note",
  s: `${title} — summary about logarithms and quadratics`,
  x: `Body of ${title}. Logarithms, quadratics, and the rest of it.`,
});

// Enough courses that the old one-row chip scroller was genuinely unusable.
const COURSES = [
  "Matematika Y3", "Matematika Y4", "Dejepis", "Biologia", "Chemia", "Fyzika",
  "Anglictina Y3", "Anglictina Y4", "Slovencina", "Informatika", "Geografia", "NaE Y3 3.T",
];
const BUNDLE = {
  version: 1,
  source: "classroom",
  generatedAt: new Date().toISOString(),
  years: ["2023-24", "2024-25", "2025-26", "2026-27"],
  courses: [],
  clusters: [],
  notes: COURSES.flatMap((course, i) => [
    note(course, ["2023-24", "2024-25", "2025-26", "2026-27"][i % 4], "Algebra", `Quadratics ${i}`),
    note(course, ["2023-24", "2024-25", "2025-26", "2026-27"][i % 4], "Logs", `Logarithms ${i}`),
  ]),
};

const browser = await chromium.launch();
const errors = [];

const openStudy = async (page) => {
  await page.evaluate(async (bundle) => {
    const local = await import("/kb-local.js");
    await local.saveKbBundle(bundle);
    const kb = await import("/kb.js");
    document.getElementById("kbView").hidden = false;
    document.getElementById("plannerView").hidden = true;
    await kb.showKbView();
  }, BUNDLE);
  await page.waitForTimeout(600);
};

try {
  // --- 2. the stat bar is one line, at every phone width -------------------
  for (const width of [390, 360, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    page.on("pageerror", (e) => errors.push(`${width}px: ${e}`));
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
    await openStudy(page);
    const bar = await page.evaluate(() => {
      const el = document.getElementById("kbMetaBar");
      const cells = [...el.children];
      return {
        height: Math.round(el.getBoundingClientRect().height),
        rows: new Set(cells.map((c) => Math.round(c.getBoundingClientRect().top))).size,
        overflows: el.scrollWidth > el.clientWidth + 1,
        text: el.textContent,
        // The words are gone from the pixels, not from the page.
        words: [...el.querySelectorAll(".stat-word")].map((w) => w.textContent.trim()),
      };
    });
    assert.equal(bar.rows, 1, `stat bar wrapped to ${bar.rows} rows at ${width}px: ${bar.text}`);
    assert.equal(bar.overflows, false, `stat bar overflows its box at ${width}px`);
    assert.ok(bar.words.includes("notes") && bar.words.includes("courses"),
      `the units must stay in the accessibility tree, got ${JSON.stringify(bar.words)}`);
    console.log(`✓ ${width}px: stat bar on one line, ${bar.height}px tall`);
    await page.close();
  }

  // Signed in, with Classroom stubbed out: the route and the scroll offset are
  // restored from `onSignedIn`, so a signed-out page never reaches that code.
  // hasTouch/isMobile so `(hover: none) and (pointer: coarse)` matches — the
  // lift is deliberately touch-only, since nothing covers anything on a mouse.
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/api/oauth-config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{\"hasRefreshTokens\":false}" }));
  await page.route("**/api/prefs**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/api/user**", (r) => r.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
  await page.route("https://www.googleapis.com/oauth2/v3/userinfo", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sub: "place-user", email: "student@example.edu" }) }));
  await page.route("https://classroom.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ courses: [] }) }));
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  await page.evaluate(async () => {
    const { storeAuthSession } = await import("/auth-session.js");
    await storeAuthSession("place-test-token", 3600);
  });
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("welcome")?.hidden === true, null, { timeout: 10000 });
  await page.locator('.view-toggle-btn[data-view="kb"]').click({ force: true });
  await page.waitForFunction(() => !document.getElementById("kbView")?.hidden, null, { timeout: 10000 });
  await openStudy(page);

  // --- 3. the filters are collapsed, and never a horizontal scroller -------
  await page.fill("#kbSearchInput", "logarithms");
  await page.waitForSelector("#kbFilterPanel:not([hidden]) .kb-chip", { timeout: 10000 });
  // A closed <details> hides its content through the shadow slot, so ask the
  // browser whether the chip is actually rendered rather than measuring a rect
  // that Chrome answers from the last layout it did.
  const chipVisible = await page.locator("#kbFilterChips .kb-chip").first().isVisible();
  const collapsed = await page.evaluate(() => {
    const panel = document.getElementById("kbFilterPanel");
    const chips = document.getElementById("kbFilterChips");
    return {
      open: panel.open,
      panelHeight: Math.round(panel.getBoundingClientRect().height),
      chipCount: chips.querySelectorAll(".kb-chip").length,
    };
  });
  assert.equal(collapsed.open, false, "the filter panel starts closed");
  assert.equal(chipVisible, false, "a closed panel shows no chips");
  assert.ok(collapsed.panelHeight <= 56,
    `closed, the filters should cost one row, took ${collapsed.panelHeight}px`);
  assert.ok(collapsed.chipCount > 20,
    `every facet is still rendered, only hidden — saw ${collapsed.chipCount} chips`);

  const opened = await page.evaluate(() => {
    const panel = document.getElementById("kbFilterPanel");
    panel.open = true;
    const chips = document.getElementById("kbFilterChips");
    return {
      scrolls: chips.scrollWidth > chips.clientWidth + 1,
      overflowX: getComputedStyle(chips).overflowX,
      rows: new Set([...chips.querySelectorAll(".kb-chip")]
        .map((c) => Math.round(c.getBoundingClientRect().top))).size,
    };
  });
  assert.equal(opened.scrolls, false, "the chips wrap; they must not scroll sideways");
  assert.notEqual(opened.overflowX, "auto", "the horizontal scroller is what was wrong with this");
  assert.ok(opened.rows > 1, "wrapping means more than one row of chips");
  console.log(`✓ filters: one ${collapsed.panelHeight}px row closed, ${opened.rows} wrapped rows open`);

  // --- ...and what is ON still shows while it is closed --------------------
  await page.evaluate(() => {
    document.getElementById("kbFilterPanel").open = true;
    document.querySelector("#kbFilterChips .kb-chip:not(.active)").click();
  });
  await page.waitForTimeout(700);
  const active = await page.evaluate(() => ({
    tags: [...document.querySelectorAll(".kb-filter-tag")].map((t) => t.textContent),
    clears: document.querySelectorAll("#kbFilterPanel .kb-clear-filters").length,
  }));
  assert.ok(active.tags.length >= 1, "an active facet appears on the summary line");
  assert.equal(active.clears, 1, "exactly one Clear control, not one per render");
  // Rendering again must not stack a second Clear onto the summary.
  await page.fill("#kbSearchInput", "quadratics");
  await page.waitForTimeout(700);
  assert.equal(
    await page.locator("#kbFilterPanel .kb-clear-filters").count(), 1,
    "Clear is replaced on re-render, not appended",
  );
  console.log(`✓ filters: active facet shown while closed (${active.tags.join(", ")}), one Clear`);

  // --- 6. focusing the search box lifts it to the TOP of the screen --------
  // The browser's own answer to the keyboard opening is to scroll the focused
  // field just clear of it, which parks the box at the BOTTOM of the remaining
  // screen with every result it is about to produce hidden underneath.
  // Blur first: filling the box above already focused it, and re-focusing an
  // already-focused element fires no focus event (nor would a real tap).
  await page.evaluate(() => { document.getElementById("kbSearchInput").blur(); window.scrollTo(0, 600); });
  await page.waitForTimeout(200);
  await page.focus("#kbSearchInput");
  await page.waitForTimeout(700); // the 350ms delay, plus the smooth scroll
  const lifted = await page.evaluate(() => {
    const box = document.getElementById("kbSearchInput").getBoundingClientRect();
    const header = document.querySelector("body > header").getBoundingClientRect();
    return { boxTop: Math.round(box.top), headerBottom: Math.round(header.bottom), vh: window.innerHeight };
  });
  assert.ok(lifted.boxTop >= lifted.headerBottom,
    `the box must clear the sticky header, sat at ${lifted.boxTop} under a header ending at ${lifted.headerBottom}`);
  assert.ok(lifted.boxTop <= lifted.headerBottom + 24,
    `the box should sit just under the header, sat ${lifted.boxTop - lifted.headerBottom}px below it`);
  console.log(`✓ search box: focus lifts it to ${lifted.boxTop}px, ${lifted.boxTop - lifted.headerBottom}px under the header`);

  // --- 1. the reader's place survives a reload ----------------------------
  // The reported symptom exactly: on a phone, an over-scroll at the top of a
  // list IS pull-to-refresh, and every one of them threw the reader back to the
  // Planner, on Search, at the top.
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(300);
  const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem("cwa_session_position")));
  assert.equal(stored.view, "kb", "the route is remembered as you move");
  assert.equal(stored.tab, "search", "so is the tab");
  assert.equal(stored.query, "quadratics", "and the query");
  assert.ok(stored.scroll >= 250, `and roughly where you were, got ${stored.scroll}`);

  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById("kbView")?.hidden, null, { timeout: 15000 });
  await page.waitForFunction(() => window.scrollY > 100, null, { timeout: 15000 });
  const restored = await page.evaluate(() => ({
    kbShown: !document.getElementById("kbView").hidden,
    plannerShown: !document.getElementById("plannerView").hidden,
    query: document.getElementById("kbSearchInput").value,
    scrollY: Math.round(window.scrollY),
    results: document.querySelectorAll("#kbResults .kb-result-card").length,
  }));
  assert.equal(restored.kbShown, true, "a reload lands back on Study, not the Planner");
  assert.equal(restored.plannerShown, false, "and only on Study");
  assert.equal(restored.query, "quadratics", "the query survives the reload");
  assert.ok(restored.results > 0, "and it was actually re-run");
  assert.ok(Math.abs(restored.scrollY - stored.scroll) <= 40,
    `should land near ${stored.scroll}px, landed at ${restored.scrollY}px`);
  console.log(`✓ reload: back on Study at ${restored.scrollY}px with the query intact`);

  // ...and the Study tab is part of it too.
  await page.evaluate(() => document.querySelector('.study-tab-btn[data-tab="curriculum"]').click());
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: "networkidle", timeout: 30000 });
  await page.waitForFunction(
    () => !document.getElementById("studyPanel-curriculum")?.hidden,
    null, { timeout: 15000 },
  );
  console.log("✓ reload: back on the Curriculum tab, not Search");

  // --- 4. the grab handle is a real control -------------------------------
  const handle = await page.evaluate(() => {
    const el = document.getElementById("aiSheetHandle");
    const cs = getComputedStyle(el);
    return { tag: el.tagName, display: cs.display, touchAction: cs.touchAction, label: el.getAttribute("aria-label") };
  });
  assert.equal(handle.tag, "BUTTON", "the handle must be focusable and operable, not a pseudo-element");
  assert.notEqual(handle.display, "none", "the handle shows on a phone");
  assert.equal(handle.touchAction, "none",
    "without touch-action:none the browser takes the vertical gesture and the drag never happens");
  assert.ok(handle.label, "the handle carries a label; the grip itself is decorative");

  await page.evaluate(() => { document.getElementById("ai").hidden = false; });
  await page.waitForTimeout(400);
  const box = await page.evaluate(() => {
    const r = document.getElementById("aiSheetHandle").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, sheet: document.getElementById("ai").getBoundingClientRect().height };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  // Well past a quarter of the sheet — a deliberate pull, not a flick.
  for (let y = box.y; y <= box.y + box.sheet * 0.5; y += 40) {
    await page.mouse.move(box.x, y);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.getElementById("ai").hidden), true,
    "pulling the handle down past the threshold dismisses the sheet");
  console.log(`✓ sheet: dragging the handle ${Math.round(box.sheet * 0.5)}px down closes it`);

  // ...and a short pull springs back rather than closing.
  await page.evaluate(() => { document.getElementById("ai").hidden = false; });
  await page.waitForTimeout(400);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let y = box.y; y <= box.y + 40; y += 10) {
    await page.mouse.move(box.x, y);
    await page.waitForTimeout(40); // slow, so it is a drag and not a flick
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const el = document.getElementById("ai");
    return { hidden: el.hidden, transform: getComputedStyle(el).transform };
  });
  assert.equal(after.hidden, false, "a short pull is not a dismissal");
  assert.ok(after.transform === "none" || after.transform === "matrix(1, 0, 0, 1, 0, 0)",
    `the sheet springs back to rest, got ${after.transform}`);
  console.log("✓ sheet: a short pull springs back");

  // --- 5. the sheet's last row clears the phone's own bottom bar -----------
  const clearance = await page.evaluate(() => {
    // What visualViewport reports when the address bar is showing. app.js sets
    // this from the real thing; a headless viewport has no browser chrome.
    document.documentElement.style.setProperty("--viewport-bottom-inset", "80px");
    const sheet = document.getElementById("ai");
    const quick = document.querySelector("#ai .ai-quick");
    const last = quick.lastElementChild;
    return {
      sheetBottom: Math.round(sheet.getBoundingClientRect().bottom),
      buttonBottom: Math.round(last.getBoundingClientRect().bottom),
      viewport: window.innerHeight,
    };
  });
  assert.equal(clearance.sheetBottom, clearance.viewport, "the sheet still meets the bottom edge");
  assert.ok(clearance.viewport - clearance.buttonBottom >= 80,
    `the last button must sit above the 80px bar; it ended ${clearance.viewport - clearance.buttonBottom}px up`);
  console.log(`✓ sheet: buttons clear an 80px bottom bar by ${clearance.viewport - clearance.buttonBottom}px`);

  assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
  await page.close();
} finally {
  await browser.close();
}

console.log("\nmobile place/sheet tests passed");
