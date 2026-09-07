// mobile_audit_test.mjs — phone-width layout audit across widths and themes.
//
// Written after the header was found to be styled for a layout it does not
// use: the max-width:640px block set flex properties on a grid, so none of it
// applied and the title's column collapsed to 13px at 390px wide and 0px at
// 320px. Nothing caught it, because every existing browser test asserted
// something specific rather than asking "is anything wrong here".
//
// So this asserts nothing about any one element. It walks the rendered page and
// reports:
//   - the page or any element overflowing the viewport horizontally
//   - content clipped by a container that cannot scroll
//   - touch targets below 32px
//   - text below 11px
//   - the header's three items overlapping each other
//
// Usage: BASE_URL=http://localhost:4321 node scripts/mobile_audit_test.mjs
//        SCREENSHOT_DIR=/tmp/shots  (optional) also writes full-page captures
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const SHOTS = process.env.SCREENSHOT_DIR || "";
const VIEWPORTS = [
  { name: "iphone-390", width: 390, height: 844 },
  { name: "android-360", width: 360, height: 800 },
  { name: "small-320", width: 320, height: 568 },
];
const MIN_TAP_PX = 32;
const MIN_FONT_PX = 11;

// Put the signed-in chrome on screen and stock the list with cards covering
// every state, including the ones that have broken before: a long unbroken
// token, a submitted card, and the three enrichment dot states.
const SETUP = () => {
  const $ = (id) => document.getElementById(id);
  $("viewToggle").hidden = false;
  const ui = $("userInfo");
  ui.hidden = false;
  ui.removeAttribute("aria-hidden");
  ui.textContent = "Signed in as Peter";
  $("menuWrap").hidden = false;
  $("welcome").hidden = true;
  $("report").hidden = false;
  $("status").textContent = "Analyzing 3 more…";

  const card = (o) => {
    const el = document.createElement("div");
    el.className = "assignment" + (o.state ? " " + o.state : "");
    const dot = document.createElement("div");
    dot.className = "priority-dot " + (o.dot || "kind-practice");
    el.appendChild(dot);
    const body = document.createElement("div");
    body.className = "assignment-body";
    const line = document.createElement("div");
    if (o.verb) {
      const v = document.createElement("span");
      v.className = "verb " + (o.verbCls || "kind-practice");
      v.textContent = o.verb;
      line.appendChild(v);
    }
    const t = document.createElement("span");
    t.className = "title";
    t.textContent = o.title;
    line.appendChild(t);
    body.appendChild(line);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML =
      `<span>${o.course}</span><span>${o.due}</span>` +
      (o.effort ? '<span class="effort">~30m</span>' : "") +
      (o.submitted ? '<span class="submitted">Submitted</span>' : "") +
      (o.overdue ? '<span class="overdue">Overdue 2d</span>' : "");
    body.appendChild(meta);
    el.appendChild(body);
    return el;
  };

  const host = $("doNowList");
  host.innerHTML = "";
  host.appendChild(card({ title: "W1 L1 - Intro do predmetu & základný framework strojového učenia", course: "ML Y4 Omega", due: "Due Fri", verb: "Worksheet", effort: true }));
  host.appendChild(card({ title: "Handed in already", course: "Matematika", due: "Due Mon", verb: "Test", state: "state-submitted", submitted: true, dot: "kind-assess", verbCls: "kind-assess" }));
  host.appendChild(card({ title: "Overdue with an unbreakable token ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", course: "Slovenský jazyk a literatúra", due: "Overdue 2d", verb: "Essay", state: "state-overdue", overdue: true, effort: true, dot: "kind-write", verbCls: "kind-write" }));
  host.appendChild(card({ title: "Not analyzed yet", course: "Fyzika", due: "No due date", dot: "unanalyzed" }));
  host.appendChild(card({ title: "Failed analysis", course: "Chémia", due: "Due Wed", dot: "failed" }));
};

const AUDIT = ({ minTap, minFont }) => {
  const vw = document.documentElement.clientWidth;
  const issues = [];
  const seen = new Set();
  const add = (kind, el, detail) => {
    const key = `${kind}:${el}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ kind, el, detail });
  };
  const name = (el) => {
    if (el.id) return "#" + el.id;
    const cls = typeof el.className === "string" ? el.className.trim() : "";
    return cls ? "." + cls.split(/\s+/).join(".") : el.tagName.toLowerCase();
  };

  if (document.documentElement.scrollWidth > vw + 1) {
    add("page-overflow", "document", `scrollWidth ${document.documentElement.scrollWidth} > viewport ${vw}`);
  }

  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    if (r.right > vw + 1 || r.left < -1) {
      add("horizontal-overflow", name(el), `left=${r.left.toFixed(0)} right=${r.right.toFixed(0)} vw=${vw}`);
    }
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && !["auto", "scroll"].includes(cs.overflowX)) {
      add("clipped-content", name(el), `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}, overflow-x=${cs.overflowX}`);
    }
    const tappable = el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "menuitem";
    if (tappable && (r.height < minTap || r.width < minTap)) {
      add("small-tap-target", name(el), `${r.width.toFixed(0)}x${r.height.toFixed(0)} < ${minTap}px`);
    }
    const fs = parseFloat(cs.fontSize);
    if (fs && fs < minFont && el.textContent.trim()) {
      add("tiny-text", name(el), `${fs}px < ${minFont}px`);
    }
  }

  // The header's three items must not collide. This is the specific failure
  // that motivated the file: #auth wrapped onto a second row and sat in the
  // middle of the header, under the view switcher.
  const items = {
    h1: document.querySelector("header h1"),
    viewToggle: document.getElementById("viewToggle"),
    auth: document.getElementById("auth"),
  };
  const overlaps = (a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return !(ra.right <= rb.left + 1 || rb.right <= ra.left + 1 || ra.bottom <= rb.top + 1 || rb.bottom <= ra.top + 1);
  };
  const keys = Object.keys(items);
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = items[keys[i]];
      const b = items[keys[j]];
      if (a && b && overlaps(a, b)) add("header-overlap", `${keys[i]} ∩ ${keys[j]}`, "header items share screen space");
    }
  }

  // A title squeezed to nothing is not an overflow or an overlap, so it needs
  // its own check: it was 13px wide for text needing 151px and every other
  // assertion passed.
  const h1 = items.h1;
  if (h1 && h1.scrollWidth > h1.clientWidth + 1) {
    add("truncated-title", "header h1", `needs ${h1.scrollWidth}px, has ${h1.clientWidth}px`);
  }

  return { viewport: vw, issues };
};

const browser = await chromium.launch();
let failures = 0;
try {
  for (const vp of VIEWPORTS) {
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, colorScheme: theme });
      await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 30000 });
      await page.evaluate(SETUP);
      await page.waitForTimeout(150);
      const res = await page.evaluate(AUDIT, { minTap: MIN_TAP_PX, minFont: MIN_FONT_PX });
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${vp.name}-${theme}.png`, fullPage: true });
      if (res.issues.length === 0) {
        console.log(`✓ ${vp.name} ${theme}: clean at ${res.viewport}px`);
      } else {
        failures += res.issues.length;
        console.error(`✗ ${vp.name} ${theme}: ${res.issues.length} issue(s)`);
        for (const i of res.issues) console.error(`    [${i.kind}] ${i.el} — ${i.detail}`);
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\nmobile audit FAILED: ${failures} issue(s)`);
  process.exit(1);
}
console.log("\nmobile audit passed");
