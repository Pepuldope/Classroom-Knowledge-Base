import { verifyUser, checkAndIncrementRate, jsonResponse } from "./_helpers.js";
import { getBundle } from "./kb-store.js";
import { searchNotes } from "./kb-retrieval.js";
import { routeChat } from "./ai-router.js";

export const config = { runtime: "edge" };

// RAG tutor: retrieves up to N relevant notes from the shared KB, injects
// them as grounded context, and streams an answer from the AI model.
// The model call goes through ai-router.js, which fails over across ALL
// configured providers (OpenRouter, local proxy, Groq, Cerebras, Mistral,
// NVIDIA, GitHub, Qwen, Google) so the tutor stays up even if one runs out.
const CONTEXT_NOTES = 6;

function buildSystemPrompt(notes) {
  const ctx = notes
    .map((n, i) => {
      const head = `NOTE ${i + 1} — "${n.t}"${n.course ? ` (${n.course}${n.y ? `, ${n.y}` : ""})` : ""}${n.topic ? ` · topic: ${n.topic}` : ""}`;
      const body = (n.x || n.s || "").slice(0, 1400);
      return `${head}\n${body}`;
    })
    .join("\n\n---\n\n");
  return [
    "You are a friendly study tutor for a student using their school's shared Classroom knowledge base.",
    "Answer using ONLY the notes provided below. If the notes do not cover the question, say so plainly and suggest what topic to look up — do NOT invent facts or pull from outside knowledge.",
    "Be encouraging and clear. Use short paragraphs, bullet points where helpful, and concrete examples drawn from the notes.",
    "When you use a fact, you may mention which note it came from (e.g. 'the STAR Method note says…').",
    "",
    "=== SHARED KNOWLEDGE BASE (retrieved notes) ===",
    ctx || "(no notes retrieved)",
  ].join("\n");
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

  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  const query = lastUser ? lastUser.content : "";

  // ---- RAG retrieval ----
  const bundle = await getBundle();
  let notes = [];
  if (bundle && Array.isArray(bundle.notes) && query) {
    notes = searchNotes(bundle.notes, query, { limit: CONTEXT_NOTES });
  }

  const systemPrompt = buildSystemPrompt(notes);
  const messages = [{ role: "system", content: systemPrompt }, ...body.messages];

  // Build the source descriptors we'll surface as clickable chips (noteIndex
  // so the UI can open the full note). Emitted early as a control SSE event.
  const sourceNotes = notes.map((n) => ({
    t: n.t, course: n.course, y: n.y, noteIndex: n.noteIndex,
  }));
  const sourcesEvent = `data: ${JSON.stringify({ type: "sources", notes: sourceNotes })}\n\n`;

  // ---- Route through all providers with failover ----
  let routed;
  try {
    routed = await routeChat(messages, { max_tokens: 4000, temperature: 0.4, stream: true });
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
      "X-RateLimit-Used": String(rate.count),
      "X-RateLimit-Limit": String(rate.limit),
    },
  });
}
