// tutor_planner_context_test.mjs — Peter's transcript, 2026-09-13.
//
//   "Need help learning for my quiz i have next week from english. Can you help
//    me find what i am supposed to learn?"
//
// The tutor listed English quizzes from ELA Y3, BEng Y1, ELA 1 Gama and BEng Y2
// — all finished classes — and asked which one he meant. The quiz was on his
// Planner: ELA Y4 Omega, in two days. This replays that question on the real
// page and checks what the tutor is sent.
//
// Usage: BASE_URL=http://localhost:4321 node scripts/tutor_planner_context_test.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { openSignedInPage, seedKb } from "./lib/harness.mjs";

const BASE = process.env.BASE_URL || "http://localhost:4321";
const inDays = (n) => { const d = new Date(Date.now() + n * 86400000); return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }; };
const now = new Date();
const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
const CURRENT = `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
const yearsAgo = (n) => `${startYear - n}-${String((startYear - n + 1) % 100).padStart(2, "0")}`;

const COURSE = { id: "ela4", name: "ELA Y4 Omega", section: CURRENT, creationTime: new Date(Date.now() - 30 * 86400000).toISOString(), courseState: "ACTIVE" };
const QUIZ = {
  id: "quiz1", courseId: "ela4", title: "(GA) Vocabulary quiz", workType: "ASSIGNMENT", state: "PUBLISHED",
  alternateLink: "https://classroom.google.com/x", creationTime: new Date().toISOString(), updateTime: new Date().toISOString(),
  dueDate: inDays(2), description: "Synonyms, similes and idioms from Sprint 1.",
};
const note = (t, course, y, x) => ({ p: `${course}/${t}`, t, course, y, topic: "Sprint 1", kind: "note", s: "", x });
const NOTES = [
  note("Adjectives - Synonyms", "ELA Y4 Omega", CURRENT, "Vocabulary for the quiz: synonyms, similes, idioms. big → large."),
  note("Idioms list", "ELA Y4 Omega", CURRENT, "Idioms for the vocabulary quiz: break the ice."),
  note("ELA Y3 (Ms Silvia) - Announcements", "ELA Y3 ( Ms Silvia)", yearsAgo(1), "Vocabulary quiz (15 min) next week."),
  note("(GA) Vocabulary Quiz", "BEng Y1", yearsAgo(3), "Vocabulary quiz and a mini assessment."),
  note("Environment - VOCABULARY QUIZ", "ELA Year 2", yearsAgo(2), "Vocab quiz on Friday next week."),
];

const browser = await chromium.launch();
let failed = false;
try {
  const { page, errors } = await openSignedInPage(browser, {
    base: BASE, viewport: { width: 1400, height: 900 },
    courses: [COURSE], courseWork: [QUIZ], submissions: [{ courseWorkId: "quiz1", state: "CREATED" }],
  });
  await page.waitForSelector(".assignment", { state: "attached", timeout: 15000 });
  await page.locator('.view-toggle-btn[data-view="kb"]').click({ force: true });
  await seedKb(page, { version: 1, source: "classroom", generatedAt: new Date().toISOString(), years: [CURRENT], courses: [], clusters: [], notes: NOTES });
  await page.evaluate(async () => { const kb = await import("/kb.js"); await kb.showKbView(); });

  let sent = null;
  await page.exposeFunction("__tutorBody", (b) => { sent = JSON.parse(b); });
  await page.evaluate(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      if (!String(url).includes("/api/tutor")) return realFetch(url, opts);
      window.__tutorBody(opts.body);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
  });
  await page.click("#kbTutorOpen");
  await page.fill("#kbTutorInput", "Need help learning for my quiz i have next week from english. Can you help me find what i am supposed to learn?");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('#kbTutorMessages [data-role="assistant"] .ai-answer-actions'), null, { timeout: 10000 });

  assert.ok(sent, "the tutor was never asked");
  assert.equal(sent.currentYear, CURRENT);
  assert.ok(sent.pendingWork.some((w) => w.title === "(GA) Vocabulary quiz" && w.course === "ELA Y4 Omega" && w.dueDate), "the Planner's quiz was not sent");
  assert.deepEqual({ title: sent.likelyWork?.title, course: sent.likelyWork?.course }, { title: "(GA) Vocabulary quiz", course: "ELA Y4 Omega" }, "the question was not matched to the quiz");
  const sentNotes = sent.notes.map((n) => `${n.t} [${n.course} ${n.y}]`);
  assert.ok(sent.notes.length >= 1 && sent.notes.every((n) => n.y === CURRENT), `finished classes were sent: ${sentNotes.join("; ")}`);
  assert.equal(sent.notes[0].course, "ELA Y4 Omega");
  console.log(`✓ matched "${sent.likelyWork.title}" (${sent.likelyWork.course}, due ${sent.likelyWork.dueDate}); sent only ${CURRENT} notes: ${sentNotes.join("; ")}`);
  assert.deepEqual(errors, []);
} catch (e) {
  failed = true;
  console.error("✗", e.message);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
