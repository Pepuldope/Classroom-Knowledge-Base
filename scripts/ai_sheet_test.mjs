// ai_sheet_test.mjs — the assignment panel is a bottom sheet on phones and an
// unchanged side panel on desktop.
//
// The panel is shown by clearing its `hidden` attribute, so the slide-up relies
// on display:none -> flex restarting the CSS animation. That is easy to break
// without noticing — swapping `hidden` for a class, or moving the animation to
// a transition, leaves the sheet appearing instantly with no error anywhere.
//
// Usage: BASE_URL=http://localhost:4321 node scripts/ai_sheet_test.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const browser = await chromium.launch();

const open = async (page) =>
  page.evaluate(async () => {
    const ai = document.getElementById("ai");
    ai.hidden = false;
    const cs = getComputedStyle(ai);
    const start = ai.getBoundingClientRect();
    const anims = ai.getAnimations().map((a) => ({
      name: a.animationName,
      duration: a.effect.getTiming().duration,
    }));
    await new Promise((r) => setTimeout(r, 450));
    const end = ai.getBoundingClientRect();
    return {
      vh: window.innerHeight,
      vw: window.innerWidth,
      radius: cs.borderTopLeftRadius,
      anims,
      startTop: Math.round(start.top),
      end: {
        top: Math.round(end.top),
        bottom: Math.round(end.bottom),
        width: Math.round(end.width),
      },
    };
  });

try {
  // --- phone -------------------------------------------------------------
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  const p = await open(phone);

  assert.equal(p.anims.length, 1, "sheet should run exactly one animation on open");
  assert.equal(p.anims[0].name, "ai-sheet-up", `expected ai-sheet-up, got ${p.anims[0].name}`);
  assert.ok(p.anims[0].duration > 0 && p.anims[0].duration <= 400,
    `animation should be quick, got ${p.anims[0].duration}ms`);
  assert.ok(p.startTop > p.end.top,
    `should travel upward: started at ${p.startTop}, settled at ${p.end.top}`);
  assert.equal(p.end.bottom, p.vh, "sheet is anchored to the bottom edge");
  assert.equal(p.end.width, p.vw, "sheet spans the full width");
  assert.ok(p.end.top > 0, "sheet stops short of the top, so the list stays visible behind it");
  assert.ok(p.end.top < p.vh * 0.15,
    `sheet should be near-fullscreen, gap was ${p.end.top}px of ${p.vh}px`);
  assert.notEqual(p.radius, "0px", "sheet has a rounded top edge");
  console.log(`✓ phone: slides ${p.startTop}px -> ${p.end.top}px in ${p.anims[0].duration}ms, ${p.vh - p.end.top}/${p.vh}px tall`);
  await phone.close();

  // --- reduced motion ----------------------------------------------------
  const still = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await still.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  const r = await open(still);
  assert.ok(r.anims[0].duration <= 1,
    `reduced motion should collapse the slide, got ${r.anims[0].duration}ms`);
  assert.equal(r.end.bottom, r.vh, "still ends in the right place with motion reduced");
  assert.ok(r.end.top > 0 && r.end.top < r.vh * 0.15, "still near-fullscreen with motion reduced");
  console.log("✓ reduced motion: appears in place, same final geometry");
  await still.close();

  // --- desktop is untouched ----------------------------------------------
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await desktop.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
  const d = await open(desktop);
  assert.equal(d.anims.length, 0, "desktop side panel should not animate");
  assert.equal(d.end.top, 0, "desktop panel runs the full height");
  assert.equal(d.end.bottom, d.vh, "desktop panel runs the full height");
  assert.ok(d.end.width < d.vw, "desktop panel is a side panel, not full width");
  console.log(`✓ desktop: unchanged ${d.end.width}px side panel`);
  await desktop.close();
} finally {
  await browser.close();
}

console.log("\nassignment sheet passed");
