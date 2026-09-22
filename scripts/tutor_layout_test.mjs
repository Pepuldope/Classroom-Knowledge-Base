// tutor_layout_test.mjs — the Study tutor's frame, reported by Pepuldo 2026-09-13.
//
//   1. the window grew with each answer (600px empty, 900px after one reply);
//   2. an empty tinted strip sat above an empty transcript, and nothing said
//      what the tutor was;
//   3. Rename / Archive were underlined text links;
//   4. the answer's actions were different heights (emoji thumbs among text);
//   5. a long question was one line scrolled sideways in a single-line input;
//   6. the Study tab strip had a 1px vertical micro scrollbar.
//
// Measured, not screenshotted: every one of these is a number a later CSS
// change can quietly move.
//
// Usage: BASE_URL=http://localhost:4321 node scripts/tutor_layout_test.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { openSignedInPage, seedKb } from "./lib/harness.mjs";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const note = (i) => ({
  p: `n${i}`, t: `Quadratics ${i}`, course: "MAT Y3", y: "2025-26", topic: "Algebra", kind: "note",
  s: "Quadratic equations summary", x: "The discriminant decides the number of roots.",
});
const BUNDLE = {
  version: 1, source: "classroom", generatedAt: new Date().toISOString(),
  years: ["2025-26"], courses: [], clusters: [], notes: Array.from({ length: 12 }, (_, i) => note(i)),
};
const LONG = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: the discriminant tells you how many roots.`).join("\n\n");

const browser = await chromium.launch();
let failed = false;
try {
  const { page, errors } = await openSignedInPage(browser, { base: BASE, viewport: { width: 1600, height: 1000 } });
  await page.locator('.view-toggle-btn[data-view="kb"]').click({ force: true });
  await seedKb(page, BUNDLE);
  await page.evaluate(async () => { const kb = await import("/kb.js"); await kb.showKbView(); });
  await page.waitForTimeout(600);

  const tabs = await page.evaluate(() => {
    const el = document.getElementById("studyTabs");
    return { scrollH: el.scrollHeight, clientH: el.clientHeight, overflowY: getComputedStyle(el).overflowY };
  });
  assert.ok(tabs.scrollH <= tabs.clientH || tabs.overflowY === "hidden", `tab strip scrolls vertically: ${JSON.stringify(tabs)}`);
  console.log("✓ Study tab strip has no vertical scroll");

  let askedWith = null;
  await page.exposeFunction("__tutorBody", (b) => { askedWith = JSON.parse(b); });
  await page.evaluate((long) => {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      if (String(url).includes("/api/tutor")) {
        window.__tutorBody(opts.body);
        const body = `data: ${JSON.stringify({ type: "sources", notes: [{ t: "Quadratics 1", course: "MAT Y3", y: "2025-26", noteIndex: 1 }] })}\n\n`
          + `data: ${JSON.stringify({ choices: [{ delta: { content: long } }] })}\n\ndata: [DONE]\n\n`;
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream", "X-KB-Notes": "1", "X-AI-Model": "model-a" } });
      }
      return realFetch(url, opts);
    };
  }, LONG);

  await page.click("#kbTutorOpen");
  await page.waitForSelector("#kbTutorModal:not([hidden])");

  // Guards the app.js quick-prompt fix: renderQuickPrompts is scoped to
  // `#ai .ai-quick .ai-quick-list` so it cannot touch the tutor modal's own,
  // separate quick-prompt list — which stays exactly the 5 static buttons
  // the markup ships.
  const tutorQuickPrompts = await page.$$eval(
    "#kbTutorModal .ai-quick-list button",
    (els) => els.map((el) => el.textContent.trim()),
  );
  assert.equal(tutorQuickPrompts.length, 5, `tutor quick prompts should stay at 5, saw: ${tutorQuickPrompts.join(", ")}`);
  assert.equal(tutorQuickPrompts[0], "Explain from scratch", `first tutor quick prompt: ${tutorQuickPrompts[0]}`);
  console.log("✓ tutor quick-prompt list untouched by the #ai quick-prompt selector fix");

  const frame = () => page.evaluate(() => Math.round(document.querySelector("#kbTutorModal .modal-card").getBoundingClientRect().height));
  const emptyH = await frame();
  const empty = await page.evaluate(() => ({
    strip: Math.round(document.getElementById("kbTutorSources").getBoundingClientRect().height),
    welcome: document.querySelector("#kbTutorMessages .ai-welcome")?.textContent || "",
    header: [...document.querySelectorAll("#kbTutorRenameThread, #kbTutorSaveChat")].map((b) => ({
      underline: getComputedStyle(b).textDecorationLine, border: getComputedStyle(b).borderTopWidth,
    })),
    input: document.getElementById("kbTutorInput").tagName,
  }));
  assert.equal(empty.strip, 0, "an empty sources strip is drawn above an empty transcript");
  assert.match(empty.welcome, /study tutor/i, "the empty tutor says nothing about what it is");
  for (const h of empty.header) {
    assert.equal(h.underline, "none", "a header action is still an underlined link");
    assert.notEqual(h.border, "0px", "a header action has no button outline");
  }
  assert.equal(empty.input, "TEXTAREA");
  console.log(`✓ empty tutor: welcome shown, no strip, header buttons outlined, ${emptyH}px frame`);

  await page.fill("#kbTutorInput", "what is the discriminant");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#kbTutorMessages .ai-answer-actions .ai-copy-btn", { timeout: 10000 });
  const afterH = await frame();
  assert.equal(afterH, emptyH, `the tutor window changed height with the answer: ${emptyH}px → ${afterH}px`);
  const actions = await page.evaluate(() => ({
    welcomeGone: !document.querySelector("#kbTutorMessages .ai-welcome"),
    heights: [...document.querySelectorAll("#kbTutorMessages .ai-answer-actions .msg-action")].map((b) => Math.round(b.getBoundingClientRect().height)),
    labels: [...document.querySelectorAll("#kbTutorMessages .ai-answer-actions .msg-action")].map((b) => b.textContent.trim()),
  }));
  assert.ok(actions.welcomeGone, "the welcome stayed above the first question");
  assert.equal(new Set(actions.heights).size, 1, `answer actions differ in height: ${actions.labels.map((l, i) => `${l}=${actions.heights[i]}`).join(", ")}`);
  assert.ok(!actions.labels.some((l) => /👍|👎/.test(l)), "the thumbs are back");
  assert.ok(actions.labels.includes("Try again"));
  console.log(`✓ Enter sends; frame stays ${afterH}px; ${actions.labels.length} actions all ${actions.heights[0]}px`);

  await page.click("#kbTutorMessages .ai-tryagain-btn");
  await page.waitForFunction(() => document.querySelectorAll('#kbTutorMessages [data-role="assistant"]').length === 1
    && document.querySelector("#kbTutorMessages .ai-tryagain-btn"), null, { timeout: 10000 });
  assert.equal(askedWith?.avoidModel, "model-a", "Try again did not ask for a different model");
  assert.equal(askedWith.messages.filter((m) => m.role === "assistant").length, 0, "Try again re-sent the answer it is replacing");
  console.log("✓ Try again replaces the answer and asks the router to avoid the model that gave it");

  await page.fill("#kbTutorInput", "word ".repeat(120));
  const box = await page.evaluate(() => {
    const i = document.getElementById("kbTutorInput");
    const send = document.querySelector("#kbTutorForm button[type=submit]");
    return { h: i.getBoundingClientRect().height, sw: i.scrollWidth, cw: i.clientWidth, sendH: send.getBoundingClientRect().height };
  });
  assert.ok(box.sw <= box.cw + 1, "a long question scrolls sideways instead of wrapping");
  assert.ok(box.h > 80 && box.h <= 170, `composer did not grow within its cap: ${box.h}px`);
  assert.ok(box.sendH < 60, `Send stretched to the composer's height: ${box.sendH}px`);
  console.log(`✓ a long question wraps and grows the composer to ${Math.round(box.h)}px; Send stays ${Math.round(box.sendH)}px`);

  // --- citations and quote checking ----------------------------------------
  // Note 1's body is "The discriminant decides the number of roots." One quote
  // is real, one is invented; the page must link [1] and flag only the second.
  await page.evaluate(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      if (String(url).includes("/api/tutor")) {
        const answer = 'Your note says "The discriminant decides the number of roots" [1]. It also says "roots are always real numbers" [1].';
        const body = `data: ${JSON.stringify({ type: "sources", notes: [{ t: "Quadratics 1", course: "MAT Y3", y: "2025-26", noteIndex: 1 }] })}\n\n`
          + `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`;
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream", "X-KB-Notes": "1", "X-AI-Model": "model-b" } });
      }
      return realFetch(url, opts);
    };
  });
  await page.fill("#kbTutorInput", "what does my note say about roots");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#kbTutorMessages .ai-quote-check", { timeout: 10000 });
  const grounded = await page.evaluate(() => {
    const answers = document.querySelectorAll('#kbTutorMessages [data-role="assistant"]');
    const last = answers[answers.length - 1];
    const check = last.querySelector(".ai-quote-check");
    return {
      cites: last.querySelectorAll(".ai-cite").length,
      warning: check.classList.contains("is-warning"),
      flagged: [...check.querySelectorAll("li")].map((li) => li.textContent),
      tryAgainButtons: document.querySelectorAll("#kbTutorMessages .ai-tryagain-btn").length,
    };
  });
  assert.equal(grounded.cites, 2, "[1] citations were not turned into links");
  assert.equal(grounded.warning, true);
  assert.equal(grounded.flagged.length, 1);
  assert.match(grounded.flagged[0], /roots are always real numbers/);
  assert.equal(grounded.tryAgainButtons, 1, "Try again is offered on more than the latest answer");
  await page.locator("#kbTutorMessages .ai-cite").last().click();
  await page.waitForSelector("#kbNoteModal:not([hidden])", { timeout: 8000 });
  assert.match(await page.locator("#kbNoteTitle").textContent(), /Quadratics 1/);
  console.log("✓ [1] opens the cited note; the invented quote is flagged and the real one is not");

  assert.deepEqual(errors, []);
} catch (e) {
  failed = true;
  console.error("✗", e.message);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
