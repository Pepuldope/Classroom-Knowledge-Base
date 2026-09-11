import test from "node:test";
import assert from "node:assert/strict";
import {
  composerStateModel, shouldFollowOutput, streamEndModel, applyComposerState,
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
