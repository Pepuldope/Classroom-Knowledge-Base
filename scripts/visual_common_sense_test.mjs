// visual_common_sense_test.mjs — standing browser gate for visual usability.
// This is intentionally DOM/computed-style based: screenshots are supporting
// evidence, not the assertion. Run against a seeded local dev server.
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const failures = [];
const fail = (msg) => failures.push(msg);

function luminance(rgb) {
  const m = String(rgb).match(/[\d.]+/g);
  if (!m || m.length < 3) return null;
  return m.slice(0, 3).map(Number).map((n) => {
    const v = n / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(fg, bg) {
  const a = luminance(fg), b = luminance(bg);
  return a == null || b == null ? null : (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function visiblyDifferent(a, b) {
  return ["backgroundColor", "color", "borderColor", "outline", "boxShadow", "opacity", "transform"].some((k) => a[k] !== b[k]);
}

async function visible(selector) {
  const loc = page.locator(selector).filter({ visible: true }).first();
  return (await loc.count()) > 0 && await loc.isVisible() ? loc : null;
}
async function style(loc) {
  return loc.evaluate((el) => {
    const s = getComputedStyle(el);
    return Object.fromEntries(["backgroundColor", "color", "borderColor", "outline", "boxShadow", "opacity", "transform"].map((k) => [k, s[k]]));
  });
}
async function forceHarnessStates() {
  await page.evaluate(() => {
    const show = (id) => { const el = document.getElementById(id); if (el) el.hidden = false; };
    ["plannerView", "archiveView", "kbView", "kbMain", "kbOnboarding", "settingsModal", "feedbackModal", "kbNoteModal"].forEach(show);
    // Keep modal samples rendered for contrast/layout checks without letting the
    // synthetic fixture intercept real hover/focus/pressed interactions.
    document.querySelectorAll(".modal").forEach((modal) => { modal.style.pointerEvents = "none"; });
    const meta = document.getElementById("kbMetaBar");
    if (meta) meta.innerHTML = '<span class="kb-loading-inline">Loading your knowledge base…</span>';
    ["kbSearchInput", "archiveSearchInput"].forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = false; });
    const results = document.getElementById("kbResults");
    if (results && !results.children.length) {
      const card = document.createElement("button");
      card.className = "assignment kb-result-card";
      card.type = "button";
      card.textContent = "Readable representative knowledge-base result";
      results.append(card);
    }
    const archive = document.getElementById("archiveMain"); if (archive) archive.hidden = false;
    const pane = document.querySelector('[data-pane="knowledge-base"]'); if (pane) pane.hidden = false;
  });
}
async function checkContrast(theme) {
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  const samples = [
    ["body", "body"], ["onboarding title", ".welcome-title"], ["onboarding step", ".step-text"],
    ["status", ".status"], ["view toggle", ".view-toggle-btn"], ["KB search", "#kbSearchInput"],
    ["settings label", ".settings-pane:not([hidden]) .settings-row > span"],
    ["modal copy", ".modal:not([hidden]) .modal-sub"], ["primary control", "button.primary"],
  ];
  for (const [name, selector] of samples) {
    const loc = await visible(selector);
    if (!loc) { fail(`${theme}: missing ${name} (${selector})`); continue; }
    const data = await loc.evaluate((el) => {
      const fg = getComputedStyle(el).color;
      let node = el;
      let bg = "rgba(0, 0, 0, 0)";
      while (node) {
        const value = getComputedStyle(node).backgroundColor;
        if (value !== "rgba(0, 0, 0, 0)" && value !== "transparent") { bg = value; break; }
        node = node.parentElement;
      }
      const s = getComputedStyle(el);
      return { fg, bg, fontSize: parseFloat(s.fontSize), fontWeight: parseInt(s.fontWeight, 10) || 400 };
    });
    const ratio = contrast(data.fg, data.bg);
    const large = data.fontSize >= 18.66 || (data.fontSize >= 14 && data.fontWeight >= 700);
    const minimum = large ? 3 : 4.5;
    if (ratio == null || ratio < minimum) fail(`${theme}: ${name} contrast ${ratio?.toFixed(2) ?? "n/a"}:1 (${data.fg} on ${data.bg}, need ${minimum}:1)`);
  }
}
async function checkControlStates() {
  const controls = [
    ["view toggle", ".view-toggle-btn"], ["primary", "button.primary"],
    ["settings select", ".settings-select"], ["search input", "#kbSearchInput, #archiveSearchInput"],
  ];
  for (const [name, selector] of controls) {
    await page.evaluate((name) => {
      const hide = (id) => { const el = document.getElementById(id); if (el) el.hidden = true; };
      if (name === "settings select") {
        ["plannerView", "archiveView", "kbView", "feedbackModal", "kbNoteModal", "kbTutorModal"].forEach(hide);
        const modal = document.getElementById("settingsModal"); if (modal) { modal.hidden = false; modal.style.pointerEvents = "auto"; }
      } else if (name === "search input") {
        ["plannerView", "archiveView", "settingsModal", "feedbackModal", "kbNoteModal", "kbTutorModal"].forEach(hide);
        const kb = document.getElementById("kbView"); if (kb) kb.hidden = false;
        const main = document.getElementById("kbMain"); if (main) main.hidden = false;
        const input = document.querySelector("#kbSearchInput, #archiveSearchInput"); if (input) input.hidden = false;
      }
    }, name);
    const loc = await visible(selector);
    if (!loc) { fail(`control missing: ${name} (${selector})`); continue; }
    const base = await style(loc);
    await loc.hover({ force: true });
    const hover = await style(loc);
    const box = await loc.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const pressed = await style(loc);
    await page.mouse.up();
    await loc.focus();
    const focus = await style(loc);
    const ring = focus.outline !== "none" || (focus.boxShadow && focus.boxShadow !== "none");
    if (!visiblyDifferent(base, hover)) fail(`${name}: hover is visually identical to default`);
    if (!visiblyDifferent(base, pressed)) fail(`${name}: pressed is visually identical to default`);
    if (!ring) fail(`${name}: focus-visible has no outline/box-shadow ring`);
    if (await loc.evaluate((el) => el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "BUTTON")) {
      await loc.evaluate((el) => { el.dataset.visualGateDisabled = "1"; el.disabled = true; });
      const disabled = await style(loc);
      await loc.evaluate((el) => { el.disabled = false; delete el.dataset.visualGateDisabled; });
      if (!visiblyDifferent(base, disabled)) fail(`${name}: disabled is visually identical to default`);
    }
  }
}
async function checkLayout() {
  const issues = await page.evaluate(() => {
    const visible = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return !el.hidden && s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0; };
    const problems = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 2) problems.push(`horizontal page overflow ${document.documentElement.scrollWidth - document.documentElement.clientWidth}px`);
    const targets = [...document.querySelectorAll("button, a, input, select, textarea, summary")].filter(visible);
    for (const el of targets) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) problems.push(`zero-size clickable ${el.tagName}#${el.id}`);
      if (r.left < -1 || r.right > innerWidth + 1) problems.push(`control outside viewport ${el.tagName}#${el.id}`);
      const text = (el.textContent || el.getAttribute("aria-label") || "").trim();
      if (text && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== "auto" && getComputedStyle(el).overflow !== "scroll") problems.push(`clipped control text ${el.tagName}#${el.id || el.className}`);
    }
    for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
      const a = targets[i], b = targets[j];
      if (a.contains(b) || b.contains(a)) continue;
      const surface = (el) => el.closest(".modal-card, section") || document.body;
      if (surface(a) !== surface(b)) continue;
      const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(x.right, y.right) - Math.max(x.left, y.left)) * Math.max(0, Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top));
      if (overlap > 24) problems.push(`overlapping hit targets ${a.id || a.className} / ${b.id || b.className}`);
    }
    return problems;
  });
  for (const issue of issues) fail(issue);
}

try {
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector("#viewToggle", { timeout: 10000 });
  await forceHarnessStates();
  for (const theme of ["light", "dark"]) await checkContrast(theme);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await checkControlStates();
  await checkLayout();
  assert.deepEqual(failures, [], failures.join("\n"));
  console.log(`✓ visual common-sense gate passed: light + dark contrast, control states, layout hygiene, KB/Archive/Planner/Settings/onboarding/loading/modal (${BASE})`);
} finally {
  await browser.close();
}
