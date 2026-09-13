import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  composerStateModel, shouldFollowOutput, streamEndModel, applyComposerState,
  createSseFramer, createDeltaStream, unwrapMathDelimiters, renderTutorAnswer,
  tutorWelcomeModel, composerKeyAction,
} from "../chat-ux.js";

test("while a reply streams, the input is closed and Send becomes Stop", () => {
  const s = composerStateModel({ busy: true, hasText: true });
  assert.equal(s.inputDisabled, true, "a second question could be sent mid-reply");
  assert.equal(s.submitLabel, "Stop");
  assert.equal(s.submitAction, "stop");
  assert.equal(s.submitDisabled, false, "stop must stay clickable");
  // The quick-prompt buttons send too; leaving them live is the same hole.
  assert.equal(s.quickDisabled, true);
});

test("a busy composer that cannot be stopped is disabled, not mislabelled", () => {
  const s = composerStateModel({ busy: true, canStop: false });
  assert.equal(s.submitDisabled, true);
  assert.equal(s.submitLabel, "Sending…");
  assert.equal(s.submitAction, "none");
});

test("idle with no text cannot send; with text it can", () => {
  assert.equal(composerStateModel({ hasText: false }).submitDisabled, true);
  assert.equal(composerStateModel({ hasText: true }).submitDisabled, false);
  assert.equal(composerStateModel({ hasText: true }).submitLabel, "Send");
  assert.equal(composerStateModel({}).quickDisabled, false);
});

// --- following the output -------------------------------------------------

test("the transcript follows new text only when you are already at the bottom", () => {
  const atBottom = { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 };
  assert.equal(shouldFollowOutput(atBottom), true);
  // Scrolled up to re-read something: yanking them down is the worst thing a
  // streaming chat can do, and it is what scrollTop = scrollHeight does.
  assert.equal(shouldFollowOutput({ scrollTop: 200, scrollHeight: 1000, clientHeight: 100 }), false);
});

test("being a few pixels off the bottom still counts as the bottom", () => {
  // Sub-pixel and zoom rounding otherwise make this intermittently false.
  assert.equal(shouldFollowOutput({ scrollTop: 880, scrollHeight: 1000, clientHeight: 100 }), true);
  assert.equal(shouldFollowOutput({ scrollTop: 851, scrollHeight: 1000, clientHeight: 100 }), false);
  // A transcript shorter than its box is trivially at the bottom.
  assert.equal(shouldFollowOutput({ scrollTop: 0, scrollHeight: 50, clientHeight: 300 }), true);
  assert.equal(shouldFollowOutput({}), true);
});

// --- what a finished stream leaves behind ---------------------------------

test("stopping a reply keeps what it had already written", () => {
  // It is usually most of the answer. Discarding it punishes the student for
  // stopping something that had already served them.
  const s = streamEndModel({ text: "An idiom is a phrase whose", aborted: true });
  assert.match(s.text, /An idiom is a phrase whose/);
  assert.match(s.text, /stopped/);
  assert.equal(s.className, "ai-msg assistant");
});

test("stopping before anything arrived says so instead of leaving a blank bubble", () => {
  const s = streamEndModel({ text: "   ", aborted: true });
  assert.match(s.text, /stopped before it answered/);
});

test("an empty completion is reported, not left blank", () => {
  // A blank assistant bubble reads as a bug, and is one of the ways a free
  // model fails — it returns 200 with no content.
  assert.match(streamEndModel({ text: "" }).text, /no answer came back/);
});

test("an error with no text shows the error; an error after text keeps the text", () => {
  assert.match(streamEndModel({ error: "AI error 502" }).text, /502/);
  assert.equal(streamEndModel({ error: "AI error 502" }).className, "ai-msg error");
  // Partial answer then a mid-stream failure: the answer is worth more than
  // the error, so it survives.
  const partial = streamEndModel({ text: "Similes compare two things", error: "connection lost" });
  assert.match(partial.text, /Similes compare two things/);
});

test("a normal completion is passed through trimmed", () => {
  const s = streamEndModel({ text: "  the answer  " });
  assert.equal(s.text, "the answer");
  assert.equal(s.className, "ai-msg assistant");
});

// --- applying state to controls -------------------------------------------

test("applying a busy state closes every route back into sending", () => {
  const input = { disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const submit = { disabled: false, textContent: "Send", dataset: {}, classList: { toggle() {} } };
  const quick = [{ disabled: false }, { disabled: false }];
  applyComposerState(composerStateModel({ busy: true }), { input, submit, quick });
  assert.equal(input.disabled, true);
  assert.equal(input.attrs["aria-busy"], "true");
  assert.equal(submit.textContent, "Stop");
  assert.equal(submit.dataset.action, "stop");
  assert.deepEqual(quick.map((q) => q.disabled), [true, true]);
  // And releasing it opens them again.
  applyComposerState(composerStateModel({ hasText: true }), { input, submit, quick });
  assert.equal(input.disabled, false);
  assert.equal(submit.textContent, "Send");
  assert.deepEqual(quick.map((q) => q.disabled), [false, false]);
});

test("applying state to missing controls does not throw", () => {
  assert.doesNotThrow(() => applyComposerState(composerStateModel({}), {}));
  assert.doesNotThrow(() => applyComposerState(composerStateModel({}), { quick: [null] }));
});

// --- reasoning models stream before they answer ---------------------------

import { deltaKind, revealAnswer, markReasoning } from "../chat-ux.js";

test("a reasoning token is not an answer token", () => {
  // The reported symptom: the dots vanished and the bubble sat empty for
  // several seconds. Every model in the chain reasons before it writes.
  assert.equal(deltaKind({ delta: { content: "An idiom" } }), "content");
  assert.equal(deltaKind({ delta: { reasoning: "the user is asking" } }), "reasoning");
  assert.equal(deltaKind({ delta: { reasoning_content: "let me check" } }), "reasoning");
  // Role-only and empty deltas open a stream and say nothing.
  assert.equal(deltaKind({ delta: { role: "assistant" } }), "none");
  assert.equal(deltaKind({ delta: { content: "" } }), "none");
  assert.equal(deltaKind({}), "none");
  assert.equal(deltaKind(null), "none");
});

test("content wins when a delta somehow carries both", () => {
  assert.equal(deltaKind({ delta: { reasoning: "hmm", content: "the answer" } }), "content");
});

// A DOM stub small enough to be obviously correct.
const stubEl = () => {
  const classes = new Set(["ai-msg", "assistant", "ai-thinking"]);
  return {
    textContent: "",
    attrs: {},
    children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(child) { this.children.push(child); return child; },
  };
};
const stubDoc = { createElement: () => ({ className: "", textContent: "" }) };

test("revealing the answer happens once, however many chunks arrive", () => {
  const el = stubEl();
  el.setAttribute("role", "status");
  assert.equal(revealAnswer(el), true, "the first content token must reveal");
  assert.equal(el.classList.contains("ai-thinking"), false);
  assert.equal(el.attrs.role, undefined);
  // The stream calls this on every chunk; only the first may do work, or the
  // bubble is wiped mid-answer.
  el.textContent = "An idiom is";
  assert.equal(revealAnswer(el), false);
  assert.equal(el.textContent, "An idiom is");
  assert.equal(revealAnswer(null), false);
});

test("the thinking label appears once, and only while still thinking", () => {
  const el = stubEl();
  assert.equal(markReasoning(el, stubDoc), true);
  assert.equal(el.children.length, 1);
  assert.match(el.children[0].textContent, /Thinking/);
  // Repeated reasoning tokens must not stack labels.
  assert.equal(markReasoning(el, stubDoc), false);
  assert.equal(el.children.length, 1);
});

test("once the answer starts, reasoning can no longer relabel the bubble", () => {
  const el = stubEl();
  revealAnswer(el);
  assert.equal(markReasoning(el, stubDoc), false, "a late reasoning token overwrote the answer");
  assert.equal(el.children.length, 0);
});

// --- SSE framing -----------------------------------------------------------
// The Study tutor dropped a word at every network chunk boundary: it split each
// decoded chunk on "\n" on its own, so a line straddling two reads was parsed
// as two fragments. The half that failed /^data:/ was skipped by `continue`,
// and the half that matched produced truncated JSON that a bare `catch {}`
// swallowed — silently, which is why nothing ever reached the console.

test("a data line split across two reads survives as one line", () => {
  const f = createSseFramer();
  assert.deepEqual(f.push('data: {"a":'), [], "half a line is not a line yet");
  assert.deepEqual(f.push('1}\n'), ['data: {"a":1}']);
});

test("no delta is lost however the stream is chopped up", () => {
  const payload =
    'data: {"n":1}\ndata: {"n":2}\ndata: {"n":3}\ndata: {"n":4}\ndata: [DONE]\n';
  // Every possible split point must reassemble to the same lines.
  for (let cut = 1; cut < payload.length; cut++) {
    const f = createSseFramer();
    const got = [...f.push(payload.slice(0, cut)), ...f.push(payload.slice(cut)), ...f.flush()];
    assert.deepEqual(
      got,
      payload.split("\n").slice(0, -1),
      `split at ${cut} lost or mangled a line`,
    );
  }
});

test("a stream that ends without a trailing newline still yields its last line", () => {
  const f = createSseFramer();
  assert.deepEqual(f.push('data: {"n":1}'), []);
  assert.deepEqual(f.flush(), ['data: {"n":1}'], "the final delta was dropped");
  assert.deepEqual(f.flush(), [], "flush must not repeat itself");
});

// --- the whole delta pipeline ----------------------------------------------
// Rebuilt from a REAL captured tutor response: 214 content deltas of a few
// characters each. The reported symptom was words missing from the middle of an
// answer while the raw stream was provably complete, so the property that
// matters is total: every delta, whatever the chunking.

const sse = (obj) => `data: ${JSON.stringify(obj)}\n`;
const contentDelta = (s) => sse({ choices: [{ delta: { content: s } }] });

function streamFor(text, { chunkSize = 7 } = {}) {
  let body = sse({ type: "sources", notes: [{ t: "A note" }] });
  for (let i = 0; i < text.length; i += chunkSize) {
    body += contentDelta(text.slice(i, i + chunkSize));
  }
  return body + "data: [DONE]\n";
}

const ANSWER =
  "A linear function is a function whose graph is a straight line, representing " +
  "a constant rate of change between two variables. It is expressed as y = mx + b.";

test("every content delta survives, whatever the network chunking", () => {
  const body = streamFor(ANSWER);
  // Network chunk sizes that deliberately do not align with line boundaries.
  for (const size of [1, 3, 13, 64, 997, body.length]) {
    let acc = "";
    const s = createDeltaStream({ onContent: (c) => { acc += c; } });
    for (let i = 0; i < body.length; i += size) s.push(body.slice(i, i + size));
    s.end();
    assert.equal(acc, ANSWER, `chunk size ${size} lost content`);
    assert.equal(s.stats().unparsable, 0, `chunk size ${size} produced an unparsable data line`);
  }
});

test("sources arrive once, and content is not confused for them", () => {
  let sources = null, acc = "";
  const s = createDeltaStream({ onContent: (c) => { acc += c; }, onSources: (n) => { sources = n; } });
  s.push(streamFor("hello"));
  s.end();
  assert.deepEqual(sources, [{ t: "A note" }]);
  assert.equal(acc, "hello");
  assert.equal(s.stats().sources, 1);
});

test("an unparsable data line is counted, not silently dropped", () => {
  const s = createDeltaStream({ onContent: () => {} });
  s.push('data: {"choices":[{"delta":{"content":"ok"}}]}\ndata: {truncated\n');
  s.end();
  assert.equal(s.stats().unparsable, 1, "a broken data line must be visible in stats");
  assert.equal(s.stats().content, 1);
});

test("a throwing callback loses that delta but not the rest of the stream", () => {
  let seen = 0;
  const s = createDeltaStream({ onContent: () => { seen++; if (seen === 2) throw new Error("render blew up"); } });
  s.push(contentDelta("a") + contentDelta("b") + contentDelta("c"));
  s.end();
  assert.equal(seen, 3, "the stream stopped at the first failing render");
  assert.equal(s.stats().callbackErrors, 1);
  assert.equal(s.stats().content, 3);
});

// --- LaTeX the page cannot typeset ------------------------------------------
// Models emit LaTeX unprompted. With no maths typesetter on the page, a student
// reads the delimiters and macro names as part of the answer — which is a large
// part of what "the tutor's answers are nonsensical" actually looked like.

test("inline and display math lose their delimiters, not their content", () => {
  assert.equal(unwrapMathDelimiters("where \\(m\\) is the slope"), "where m is the slope");
  assert.equal(
    unwrapMathDelimiters("form\n\\[\nf(x)=mx+b\n\\]\nwhere").replace(/\n+/g, "|"),
    "form|f(x)=mx+b|where",
  );
});

test("spacing macros and text{} become the prose they stood for", () => {
  assert.equal(
    unwrapMathDelimiters("\\(f(x)=mx+b \\qquad\\text{or}\\qquad y=mx+b\\)"),
    "f(x)=mx+b or y=mx+b",
  );
});

test("dollar-delimited maths is unwrapped too", () => {
  assert.equal(
    unwrapMathDelimiters("The slope is $$m = 2$$ here").replace(/\n+/g, "|"),
    "The slope is |m = 2| here",
  );
  assert.equal(unwrapMathDelimiters("a $x$ b"), "a x b");
});

test("a fraction becomes something a student can read", () => {
  assert.equal(
    unwrapMathDelimiters("$$m = \\frac{y_2 - y_1}{x_2 - x_1}$$").trim(),
    "m = (y_2 - y_1)/(x_2 - x_1)",
  );
});

test("a price is not mistaken for maths", () => {
  // The single-dollar rule must not fire on money, which is why it refuses a
  // digit immediately after the opening $.
  assert.equal(unwrapMathDelimiters("it costs $5 and $10"), "it costs $5 and $10");
});

// Live, 2026-09-13: a model wrote the quadratic formula with no delimiters and
// the fraction rule could not see past the root nested in its numerator.
test("undelimited maths with nested macros is readable", () => {
  assert.equal(unwrapMathDelimiters("x_{1,2} = \\frac{-b \\pm \\sqrt{D}}{2a}"), "x₁,₂ = (-b ± √(D))/(2a)");
  assert.equal(unwrapMathDelimiters("\\(a \\cdot b \\leq c^{2}\\)"), "a · b ≤ c^2");
  assert.equal(unwrapMathDelimiters("\\frac{\\frac{1}{2}}{3}"), "((1)/(2))/(3)");
  // Unknown macros are left as written, and a word after a backslash is not eaten.
  assert.equal(unwrapMathDelimiters("\\mathbb{R} and \\topology"), "\\mathbb{R} and \\topology");
});

test("text with no maths in it is returned untouched", () => {
  const plain = "A linear function has a constant rate of change.";
  assert.equal(unwrapMathDelimiters(plain), plain);
  assert.equal(unwrapMathDelimiters(""), "");
  assert.equal(unwrapMathDelimiters(null), "");
});


// Both tutors render answers through one escaping renderer. The Planner used to
// feed marked's output to innerHTML, and marked passes raw HTML through.
test("a tutor answer cannot inject markup, whatever the model writes", () => {
  const html = renderTutorAnswer('Here <img src=x onerror="alert(1)"> and <script>alert(2)</script>');
  assert.ok(!/<img|<script/i.test(html), `raw HTML survived: ${html}`);
  assert.match(html, /&lt;img/);
});

// renderRichMarkdown rendered one line at a time, so a list was one <ul> per
// item and a fenced code block could never see its closing fence.
test("a list is one list, and a code block is one block", () => {
  const html = renderTutorAnswer("Steps:\n\n- one\n- two\n- three\n\n```\nx = 1\ny = 2\n```");
  assert.equal((html.match(/<ul>/g) || []).length, 1, html);
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.equal((html.match(/<pre>/g) || []).length, 1, html);
  assert.match(html, /x = 1\ny = 2/);
});

test("a tutor answer renders tables and unwraps maths", () => {
  const html = renderTutorAnswer("| x | y |\n|---|---|\n| 1 | 2 |\n\nSlope: \\(\\frac{a}{b}\\)");
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /\(a\)\/\(b\)/);
  assert.equal(renderTutorAnswer(null), "");
});

test("both tutors use the shared renderer, and Study answers get the answer styles", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const kb = readFileSync(new URL("../kb.js", import.meta.url), "utf8");
  assert.ok(!/window\.marked|marked\.min\.js/.test(app), "the Planner is back on the unsanitised CDN renderer");
  assert.match(app, /renderTutorAnswer\(/);
  assert.match(kb, /renderTutorAnswer\(/);
  // The Study bubble is .ai-msg-assistant, the Planner's is .ai-msg.assistant;
  // table and heading rules written for only one left Study answers unstyled.
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  for (const el of ["table", "pre", "h3", "blockquote"]) {
    assert.ok(css.includes(`:is(.ai-msg.assistant, .ai-msg-assistant) ${el} `), `no shared ${el} rule`);
  }
});

test("the tutor's welcome says what it answers from, and names what is open", () => {
  const w = tutorWelcomeModel({ noteCount: 1185, courseCount: 45, focusTitle: "Kvadratická funkcia" });
  assert.equal(w.title, "Hi, I'm your study tutor.");
  assert.match(w.lines[0], /1,185 notes across 45 courses/);
  assert.match(w.lines.join(" "), /say so and point you to the material/);
  assert.match(w.lines.at(-1), /“Kvadratická funkcia” open/);
  // Nothing open, nothing claimed about it; nothing built, no invented count.
  const bare = tutorWelcomeModel();
  assert.equal(bare.lines.length, 2);
  assert.doesNotMatch(bare.lines.join(" "), /\d/);
  assert.match(tutorWelcomeModel({ noteCount: 3, courseCount: 1 }).lines[0], /1 course\./);
  assert.match(tutorWelcomeModel({ language: "sk" }).title, /tútor/);
});

test("Enter sends, Shift+Enter is a new line, and an IME keeps its Enter", () => {
  assert.equal(composerKeyAction({ key: "Enter" }), "send");
  assert.equal(composerKeyAction({ key: "Enter", shiftKey: true }), "newline");
  assert.equal(composerKeyAction({ key: "Enter", isComposing: true }), "none");
  assert.equal(composerKeyAction({ key: "a" }), "none");
});
