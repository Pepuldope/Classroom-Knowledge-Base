// tutor_stall_test.mjs — a tutor reply that never comes, found live 2026-09-13.
//
// OpenRouter answered HTTP 200 for nemotron-3-ultra:free and then sent only
// keep-alives. The page painted an EMPTY bubble — no text, no Retry, no Try
// again — and pushed an empty assistant turn into the thread. The server now
// fails over on a stall and routes inside the stream (tests/stream-stall.test.js);
// this is the page's half: whatever ends without an answer must say so.
//
//   1. a stream with no answer shows "no answer came back" and a Retry;
//   2. Retry asks again without an empty assistant turn in the history;
//   3. the model named by the `route` event is the one Try again avoids;
//   4. an `error` event is shown as the error, with a Retry.
//
// Usage: BASE_URL=http://localhost:4321 node scripts/tutor_stall_test.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { openSignedInPage, seedKb } from "./lib/harness.mjs";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const BUNDLE = {
  version: 1, source: "classroom", generatedAt: new Date().toISOString(),
  years: ["2025-26"], courses: [], clusters: [],
  notes: [{ p: "n1", t: "Idioms", course: "ELA Y4", y: "2025-26", topic: "Vocabulary", kind: "note", s: "Idioms", x: "To spill the beans means to reveal a secret." }],
};

const browser = await chromium.launch();
let failed = false;
try {
  const { page, errors } = await openSignedInPage(browser, { base: BASE, viewport: { width: 1400, height: 900 } });
  await page.locator('.view-toggle-btn[data-view="kb"]').click({ force: true });
  await seedKb(page, BUNDLE);
  await page.evaluate(async () => { const kb = await import("/kb.js"); await kb.showKbView(); });
  await page.waitForTimeout(400);

  // The next /api/tutor reply is whatever window.__nextTutor names.
  const bodies = [];
  await page.exposeFunction("__tutorBody", (b) => { bodies.push(JSON.parse(b)); });
  await page.evaluate(() => {
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    const sources = sse({ type: "sources", notes: [{ t: "Idioms", course: "ELA Y4", y: "2025-26", noteIndex: 0 }] });
    const replies = {
      stalled: sources + ": routing\n\n: OPENROUTER PROCESSING\n\ndata: [DONE]\n\n",
      failed: sources + sse({ type: "error", error: "AI request failed", details: "All AI providers failed: openrouter nex sent no data in 20s" }) + "data: [DONE]\n\n",
      answer: sources + sse({ type: "route", provider: "openrouter", model: "model-z" })
        + sse({ choices: [{ delta: { content: "It means to reveal a secret [1]." } }] }) + "data: [DONE]\n\n",
    };
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      if (!String(url).includes("/api/tutor")) return realFetch(url, opts);
      window.__tutorBody(opts.body);
      // No X-AI-Model header: the route event is the only place the model is named.
      return new Response(replies[window.__nextTutor], { status: 200, headers: { "Content-Type": "text/event-stream", "X-KB-Notes": "1" } });
    };
  });

  const lastAssistant = () => page.evaluate(() => {
    const all = document.querySelectorAll('#kbTutorMessages [data-role="assistant"]');
    const el = all[all.length - 1];
    return el ? {
      count: all.length,
      text: el.textContent.trim(),
      thinking: el.classList.contains("ai-thinking"),
      buttons: [...el.querySelectorAll(".msg-action")].map((b) => b.textContent.trim()),
    } : null;
  });

  await page.click("#kbTutorOpen");
  await page.waitForSelector("#kbTutorModal:not([hidden])");

  await page.evaluate(() => { window.__nextTutor = "stalled"; });
  await page.fill("#kbTutorInput", "what does spill the beans mean");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#kbTutorMessages .ai-retry-btn", { timeout: 10000 });
  const stalled = await lastAssistant();
  assert.equal(stalled.thinking, false, "the thinking dots stayed up after the stream ended");
  assert.match(stalled.text, /no answer came back/i, `an empty reply is not explained: "${stalled.text}"`);
  assert.ok(stalled.buttons.includes("Retry"), `no Retry on an empty reply: ${stalled.buttons}`);
  assert.ok(!stalled.buttons.includes("Try again"), "an empty reply offers Try again, which has nothing to replace");
  console.log("✓ a reply that never comes says so and offers Retry");

  await page.evaluate(() => { window.__nextTutor = "answer"; });
  await page.click("#kbTutorMessages .ai-retry-btn");
  await page.waitForSelector("#kbTutorMessages .ai-tryagain-btn", { timeout: 10000 });
  const retried = bodies[bodies.length - 1];
  assert.equal(retried.messages.filter((m) => m.role === "assistant").length, 0, "the empty reply went into the thread as an assistant turn");
  assert.equal(retried.messages.filter((m) => m.role === "user").length, 1, "Retry duplicated the question");
  console.log("✓ Retry re-asks once, with no empty assistant turn in the history");

  await page.click("#kbTutorMessages .ai-tryagain-btn");
  await page.waitForSelector("#kbTutorMessages .ai-tryagain-btn", { timeout: 10000 });
  assert.equal(bodies[bodies.length - 1].avoidModel, "model-z", "Try again did not avoid the model the route event named");
  console.log("✓ Try again avoids the model named by the route event");

  await page.evaluate(() => { window.__nextTutor = "failed"; });
  await page.fill("#kbTutorInput", "and to kick the bucket?");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const all = document.querySelectorAll('#kbTutorMessages [data-role="assistant"]');
    return all[all.length - 1]?.querySelector(".ai-retry-btn");
  }, null, { timeout: 10000 });
  const failedReply = await lastAssistant();
  assert.match(failedReply.text, /All AI providers failed/, `the routing error was not shown: "${failedReply.text}"`);
  assert.ok(failedReply.buttons.includes("Retry"));
  console.log("✓ a routing failure inside the stream is shown, with Retry");

  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
} catch (e) {
  failed = true;
  console.error("✗", e.message);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
