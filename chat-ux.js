// chat-ux.js — the behaviour both AI surfaces need and neither had.
//
// The Planner popup and the Study tutor grew separately and ended up with two
// copies of "append a bubble, then stream into it". Neither had the parts that
// make a chat feel like it is working: nothing said the model was thinking
// beyond a literal "…", nothing stopped you sending three questions into a
// stream that had not answered the first, and nothing could cancel a long
// answer once it started.
//
// The models here are pure so they can be tested without a browser; the DOM
// helpers below them are deliberately thin.

/**
 * What the composer should look like right now.
 *
 * `busy` is the whole input story: while a reply is streaming, the send button
 * becomes a stop button rather than going dead. A disabled button with no way
 * to abort is the worst of both — you cannot send, and you cannot stop what is
 * blocking you.
 */
export function composerStateModel({ busy = false, hasText = false, canStop = true } = {}) {
  if (busy) {
    return {
      inputDisabled: true,
      submitDisabled: !canStop,
      submitLabel: canStop ? "Stop" : "Sending…",
      submitAction: canStop ? "stop" : "none",
      quickDisabled: true,
      status: "Thinking…",
    };
  }
  return {
    inputDisabled: false,
    submitDisabled: !hasText,
    submitLabel: "Send",
    submitAction: "send",
    quickDisabled: false,
    status: "",
  };
}

/**
 * Should the transcript follow new text?
 *
 * Only when the reader is already at the bottom. Scrolling someone back down
 * while they are reading an earlier part of a long answer is the single most
 * irritating thing a streaming chat can do, and it is what a naive
 * `scrollTop = scrollHeight` on every chunk does.
 *
 * The threshold absorbs sub-pixel and zoom rounding, which otherwise makes
 * "at the bottom" intermittently false at certain zoom levels.
 */
export function shouldFollowOutput({ scrollTop = 0, scrollHeight = 0, clientHeight = 0, threshold = 48 } = {}) {
  const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
  return distanceFromBottom <= threshold;
}

/**
 * What a stream that ended should leave behind.
 *
 * A cancelled reply keeps the text it had produced — it is usually most of the
 * answer, and throwing it away punishes the student for stopping something
 * that had already served them. An empty one says so rather than leaving a
 * blank bubble, which reads as a bug.
 */
export function streamEndModel({ text = "", aborted = false, error = "" } = {}) {
  const body = String(text || "").trim();
  if (error && !body) return { text: `❌ ${error}`, className: "ai-msg error", keep: true };
  if (aborted) {
    return body
      ? { text: `${body}\n\n_(stopped)_`, className: "ai-msg assistant", keep: true }
      : { text: "_(stopped before it answered)_", className: "ai-msg assistant", keep: true };
  }
  if (!body) return { text: "_(no answer came back — try again)_", className: "ai-msg assistant", keep: true };
  return { text: body, className: "ai-msg assistant", keep: true };
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/** The animated "thinking" bubble. Three dots, staggered; CSS does the motion. */
export function thinkingBubble(doc = document) {
  const el = doc.createElement("div");
  el.className = "ai-msg assistant ai-thinking";
  el.setAttribute("role", "status");
  el.setAttribute("aria-label", "The tutor is thinking");
  const dots = doc.createElement("span");
  dots.className = "ai-thinking-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) dots.appendChild(doc.createElement("i"));
  el.appendChild(dots);
  return el;
}

/**
 * Apply a composer state to real controls.
 *
 * `quick` is the row of one-tap prompt buttons. They send too, so leaving them
 * live while the input is disabled is a hole straight back into the bug.
 */
export function applyComposerState(state, { input, submit, quick = [] } = {}) {
  if (input) {
    input.disabled = state.inputDisabled;
    input.setAttribute("aria-busy", String(state.inputDisabled));
  }
  if (submit) {
    submit.disabled = state.submitDisabled;
    submit.textContent = state.submitLabel;
    submit.dataset.action = state.submitAction;
    submit.classList.toggle("is-stop", state.submitAction === "stop");
  }
  for (const button of quick) {
    if (button) button.disabled = state.quickDisabled;
  }
  return state;
}

/** Scroll a transcript to the bottom, but only if the reader was already there. */
export function followOutput(container, wasAtBottom) {
  if (!container || !wasAtBottom) return false;
  container.scrollTop = container.scrollHeight;
  return true;
}

/** Read whether the transcript is at the bottom, before new content lands. */
export function isAtBottom(container, threshold = 48) {
  if (!container) return true;
  return shouldFollowOutput({
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    threshold,
  });
}
