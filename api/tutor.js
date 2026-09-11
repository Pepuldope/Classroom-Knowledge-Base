import { verifyUser, checkAndIncrementRate, jsonResponse } from "./_helpers.js";
import { routeChat } from "./ai-router.js";

export const config = { runtime: "edge" };

// RAG tutor: receives only the notes retrieved in the student's browser,
// injects them as grounded context, and streams an answer from the AI model.
// The model call goes through ai-router.js, which fails over across ALL
// configured providers (OpenRouter, local proxy, Groq, Cerebras, Mistral,
// NVIDIA, GitHub, Qwen, Google) so the tutor stays up even if one runs out.
const CONTEXT_NOTES = 6;
const MAX_ATTACHMENTS = 8;

/** Keep the server-side model context bounded and free of client metadata. */
export function normalizeTutorNotes(notes, limit = CONTEXT_NOTES) {
  if (!Array.isArray(notes)) return [];
  return notes.slice(0, Math.max(0, limit)).map((n) => ({
    t: typeof n?.t === "string" ? n.t.slice(0, 300) : "",
    course: typeof n?.course === "string" ? n.course.slice(0, 160) : "",
    y: typeof n?.y === "string" ? n.y.slice(0, 40) : "",
    topic: typeof n?.topic === "string" ? n.topic.slice(0, 160) : "",
    s: typeof n?.s === "string" ? n.s.slice(0, 1400) : "",
    x: typeof n?.x === "string" ? n.x.slice(0, 1400) : "",
    noteIndex: Number.isInteger(n?.noteIndex) ? n.noteIndex : undefined,
  }));
}

const str = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/**
 * The thing the student currently has open, normalized and bounded.
 *
 * Returns null when there is no anchor, which is a real state: the Study tutor
 * can be asked a question with nothing open, and the prompt has to say so
 * rather than imply an anchor that does not exist.
 *
 * `attachments` is an array, and an EMPTY array is not the same as a missing
 * one. "This assignment has three attachments" and "this assignment has none"
 * are both answers; "I don't know what's attached" is the thing to avoid, and
 * it is what the tutor had to say before, because absence was silent.
 */
export function tutorFocusModel(focus) {
  if (!focus || typeof focus !== "object") return null;
  const title = str(focus.title, 300);
  if (!title) return null;
  const rawAttachments = Array.isArray(focus.attachments) ? focus.attachments : null;
  const attachments = (rawAttachments || []).slice(0, MAX_ATTACHMENTS).map((a) => ({
    title: str(a?.title, 240) || "Untitled attachment",
    kind: str(a?.kind, 40),
    link: str(a?.link, 500),
    text: str(a?.text, 2000),
  })).filter((a) => a.title);
  return {
    title,
    kind: str(focus.kind, 40) || "assignment",
    course: str(focus.course, 160),
    y: str(focus.y, 40),
    topic: str(focus.topic, 160),
    description: str(focus.description, 3000),
    dueDate: str(focus.dueDate, 40),
    dueInDays: Number.isFinite(Number(focus.dueInDays)) ? Math.trunc(Number(focus.dueInDays)) : null,
    submitted: typeof focus.submitted === "boolean" ? focus.submitted : null,
    link: str(focus.link, 500),
    // null means "the client did not tell us"; [] means "we know: nothing".
    attachments: rawAttachments ? attachments : null,
  };
}

export function tutorLanguageInstruction(language = "en") {
  return language === "sk"
    ? "Reply in Slovak (slovenčina), while keeping note titles and quoted source text unchanged."
    : "";
}

function dueLine(focus, today) {
  if (!focus.dueDate) return "Due: no due date set";
  const days = focus.dueInDays;
  if (days == null) return `Due: ${focus.dueDate}`;
  if (days < 0) return `Due: ${focus.dueDate} — ${-days} day(s) AGO`;
  if (days === 0) return `Due: ${focus.dueDate} — TODAY`;
  if (days === 1) return `Due: ${focus.dueDate} — TOMORROW`;
  return `Due: ${focus.dueDate} — in ${days} days`;
}

/**
 * Render the anchor.
 *
 * This block is the whole point of the rewrite. The Planner popup always sent
 * the open assignment, but buildSystemPrompt rendered it as "NOTE 1" among the
 * retrieved notes, identical in form to five keyword matches from other classes
 * and other years. Asked "what do I need to know for this quiz?", the model
 * correctly described NOTE 1 and then asked WHICH QUIZ THE STUDENT MEANT —
 * it had the anchor and had no way to tell it was the anchor.
 */
export function renderFocusBlock(focus, today = "") {
  if (!focus) return "";
  const where = [focus.course, focus.y].filter(Boolean).join(", ");
  const lines = [
    "=== WHAT THE STUDENT IS LOOKING AT RIGHT NOW ===",
    "This is the open item. Unless they clearly ask about something else, EVERY question is about THIS.",
    "",
    `${focus.kind === "material" ? "Material" : "Assignment"}: "${focus.title}"`,
    where ? `Class: ${where}` : "Class: not recorded",
    focus.topic ? `Topic: ${focus.topic}` : "",
    dueLine(focus, today),
    focus.submitted === null ? "" : `Status: ${focus.submitted ? "already handed in" : "NOT handed in yet"}`,
    focus.link ? `Classroom link: ${focus.link}` : "",
  ].filter(Boolean);

  if (focus.description) lines.push("", "Description as written by the teacher:", focus.description);

  if (focus.attachments === null) {
    lines.push("", "Attached materials: not known (do not claim there are none).");
  } else if (focus.attachments.length === 0) {
    // Said explicitly, because the student WILL ask "is there anything attached?"
    // and silence is not an answer they can act on.
    lines.push("", "Attached materials: NONE. This item has no attachments — say so plainly if asked.");
  } else {
    lines.push("", `Attached materials (${focus.attachments.length}):`);
    focus.attachments.forEach((a, i) => {
      const head = `${i + 1}. ${a.kind ? `[${a.kind}] ` : ""}${a.title}${a.link ? ` — ${a.link}` : ""}`;
      lines.push(a.text ? `${head}\n   Contents:\n   ${a.text.replace(/\n/g, "\n   ")}` : `${head} (contents not readable — you can name it but not quote it)`);
    });
  }
  return lines.join("\n");
}

function renderNotesBlock(notes, hasFocus) {
  const ctx = notes
    .map((n, i) => {
      const head = `NOTE ${i + 1} — "${n.t}"${n.course ? ` (${n.course}${n.y ? `, ${n.y}` : ""})` : ""}${n.topic ? ` · topic: ${n.topic}` : ""}`;
      const body = (n.x || n.s || "").slice(0, 1400);
      return `${head}\n${body}`;
    })
    .join("\n\n---\n\n");
  const heading = hasFocus
    ? [
        "=== BACKGROUND: OTHER NOTES FROM THEIR KNOWLEDGE BASE ===",
        "Supporting material only. These were found by search and may be from OTHER classes or OTHER years —",
        "check the class and year on each before relying on it, and never mistake one of these for the open item above.",
      ].join("\n")
    : "=== THE STUDENT'S KNOWLEDGE BASE (retrieved notes) ===";
  return `${heading}\n\n${ctx || "(no notes retrieved)"}`;
}

function buildSystemPrompt(notes, { focus = null, language = "en", today = "" } = {}) {
  const rules = [
    "You are a friendly, encouraging study tutor for a student using their private Classroom knowledge base.",
    "",
    "HOW TO USE WHAT YOU ARE GIVEN:",
    // The line the reported transcript needed and did not have.
    focus
      ? "- An item is open. Answer about THAT item. Do NOT ask the student which assignment, class or quiz they mean — you have been told. Only ask if they genuinely raise a different subject."
      : "- Nothing is open right now. If the question is ambiguous across several notes, it is fair to ask which one they mean.",
    "- FACTS ABOUT THEIR COURSE — what is on a quiz, what a task asks for, when something is due, what was covered, what is attached — come ONLY from the context below. If it is not there, say plainly that you cannot see it rather than guessing.",
    "- EXPLAINING A CONCEPT is different. If the material names something and the student asks what it IS, explain it properly using your own knowledge. Do not refuse to teach because the note is terse.",
    "- Keep the two visibly apart. Course facts can be attributed ('your quiz note lists…'); general explanation should read as general explanation.",
    "- Never invent a due date, a grade, a task requirement or an attachment. Those are facts, and a wrong one costs the student marks.",
    tutorLanguageInstruction(language),
    "",
    "STYLE: short paragraphs, bullets where they help, concrete examples taken from their own material wherever possible.",
    today ? `Today's date is ${today}.` : "",
    "",
  ].filter(Boolean);

  const focusBlock = renderFocusBlock(focus, today);
  return [
    rules.join("\n"),
    focusBlock,
    focusBlock ? "" : null,
    renderNotesBlock(notes, !!focus),
  ].filter((part) => part !== null).join("\n");
}

/**
 * Build the shared grounded conversation used by KB and Planner tutor clients.
 *
 * The third argument accepts either the old language string or an options
 * object, because kb_e2e_test and older callers pass `"sk"` positionally.
 */
export function buildTutorMessages(messages, notes, options = {}) {
  const opts = typeof options === "string" ? { language: options } : (options || {});
  const safeMessages = Array.isArray(messages) ? messages : [];
  const safeNotes = normalizeTutorNotes(notes);
  const focus = tutorFocusModel(opts.focus);
  const language = opts.language === "sk" ? "sk" : "en";
  const today = typeof opts.today === "string" ? opts.today : "";
  return [
    { role: "system", content: buildSystemPrompt(safeNotes, { focus, language, today }) },
    ...safeMessages,
  ];
}

// Questions whose answer is COPIED OUT of the context we already supplied:
// the due date, the task list, what is attached. A 550B model adds nothing to
// reading a field back, and every call spends a slot on one shared free key.
const LOOKUP_PATTERNS = [
  /\bwhen\s+(is|was|does|do)\b/i,
  /\b(due|deadline|hand(ed)?\s*in|submitted|turned\s*in)\b/i,
  /\bwhat('?s| is| are)?\s+(attached|the attachments?|included)\b/i,
  /\bwhat\s+do\s+i\s+need\s+(to know|for)\b/i,
  /\b(list|summar(ise|ize|y)|overview|recap|tl;?dr)\b/i,
  /\bwhich\s+(class|course|topic|sprint)\b/i,
  /\bhave\s+i\s+(done|submitted|handed)\b/i,
];

// Questions that need actual reasoning or teaching. These win over a lookup
// match, because "explain what I need to know" is a teaching request wearing a
// lookup's words.
const REASONING_PATTERNS = [
  /\bexplain\b|\bwhy\b|\bhow\s+(do|does|can|would|should)\b/i,
  /\b(prove|derive|solve|calculate|work\s+out|step[-\s]?by[-\s]?step)\b/i,
  /\bi\s+(don'?t|do not|can'?t)\s+(understand|get|follow)\b/i,
  /\b(difference|compare|contrast|versus|vs\.?)\b/i,
  /\b(quiz|test)\s+me\b|\bpractice\b|\bexample[s]?\s+of\b/i,
  /\bwhat\s+(is|are)\s+(a|an|the)?\s*\w+\s*\?*$/i,
];

/**
 * Which tier this question deserves.
 *
 * A local heuristic, not a model call. The router can classify with a cheap
 * model first, but here that would mean a second round trip against the SAME
 * single free key before the student sees a token — paying latency and quota
 * to save quota.
 *
 * It is deliberately biased. Only a confident lookup is downgraded; everything
 * else, including anything ambiguous, gets the strong tier. Answering a lookup
 * with a big model is merely wasteful. Answering "explain this proof" with the
 * smallest model gives a student a worse explanation, and they have no way to
 * know that is why.
 */
export function tutorQuestionTier(messages) {
  const last = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((m) => m?.role === "user")?.content;
  const text = typeof last === "string" ? last.trim().slice(0, 500) : "";
  if (!text) return "tutor";
  if (REASONING_PATTERNS.some((re) => re.test(text))) return "hard";
  if (LOOKUP_PATTERNS.some((re) => re.test(text))) return "quick";
  // A long question is doing something more than asking for a field back.
  if (text.length > 180) return "hard";
  return "tutor";
}

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const sub = await verifyUser(req);
  if (!sub) return jsonResponse({ error: "unauthorized" }, 401);

  const rate = await checkAndIncrementRate(sub);
  if (!rate.ok) {
    return jsonResponse({ error: "rate_limited", limit: rate.limit, message: `Daily tutor limit reached (${rate.limit}). Resets at midnight UTC.` }, 429);
  }

  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.messages)) return jsonResponse({ error: "messages array required" }, 400);

  // The browser performs retrieval over its private IndexedDB bundle. The
  // server never reads a shared bundle and receives only this bounded context.
  const notes = normalizeTutorNotes(body.notes);
  const language = body.language === "sk" ? "sk" : "en";

  // `focus` is the item the student has open. Its absence is a valid state and
  // the prompt says so; what it must never do is silently imply an anchor.
  const task = tutorQuestionTier(body.messages);
  const messages = buildTutorMessages(body.messages, notes, {
    language,
    focus: body.focus,
    today: new Date().toISOString().slice(0, 10),
  });

  // Build the source descriptors we'll surface as clickable chips (noteIndex
  // so the UI can open the full note). Emitted early as a control SSE event.
  const sourceNotes = notes.map((n) => ({
    t: n.t, course: n.course, y: n.y, noteIndex: n.noteIndex,
  }));
  const sourcesEvent = `data: ${JSON.stringify({ type: "sources", notes: sourceNotes })}\n\n`;

  // ---- Route through all providers with failover ----
  let routed;
  try {
    // Per-question routing. With one provider configured, the tier no longer
    // selects a provider — it selects a model inside that provider's chain.
    routed = await routeChat(messages, { task, stream: true });
  } catch (e) {
    return jsonResponse({ error: "AI request failed", details: e.message }, 502);
  }

  // Compose the stream: lead with the sources control event, then the model's
  // SSE payload verbatim, then the [DONE] terminator.
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(sourcesEvent));
      const reader = routed.stream.getReader();
      const pump = () =>
        reader.read().then(({ done, value }) => {
          if (done) { controller.enqueue(enc.encode("\ndata: [DONE]\n\n")); controller.close(); return; }
          controller.enqueue(value);
          return pump();
        });
      pump().catch((e) => { try { controller.error(e); } catch {} });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-KB-Notes": String(notes.length),
      "X-AI-Provider": routed.provider,
      "X-AI-Model": routed.model,
      "X-AI-Tier": String(routed.meta?.tier ?? ""),
      "X-AI-Task": task,
      "X-AI-Attempts": String(routed.meta?.attempts ?? 1),
      "X-AI-Fallback": routed.meta?.fallbackReason || "none",
      "X-RateLimit-Used": String(rate.count),
      "X-RateLimit-Limit": String(rate.limit),
    },
  });
}
