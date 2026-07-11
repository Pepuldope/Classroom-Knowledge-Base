import { verifyUser, checkAndIncrementRate, jsonResponse } from "./_helpers.js";
import { getBundle } from "./kb-store.js";
import { searchNotes } from "./kb-retrieval.js";

export const config = { runtime: "edge" };

// RAG tutor: retrieves up to N relevant notes from the shared KB, injects
// them as grounded context, and streams an answer from the AI model.
const PRIMARY_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free";
const BACKUP_MODEL = "nvidia/nemotron-nano-9b-v2:free";
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

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return jsonResponse({ error: "OPENROUTER_API_KEY not configured" }, 500);

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

  const callModel = (model) =>
    fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://classroom-knowledge-base.vercel.app",
        "X-Title": "Classroom Knowledge Base",
      },
      body: JSON.stringify({ model, messages, max_tokens: 4000, temperature: 0.4, stream: true }),
    });

  let upstream = await callModel(PRIMARY_MODEL);
  if (!upstream.ok || !upstream.body) upstream = await callModel(BACKUP_MODEL);
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return jsonResponse({ error: "AI request failed", details: text }, 502);
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-KB-Notes": String(notes.length),
      "X-RateLimit-Used": String(rate.count),
      "X-RateLimit-Limit": String(rate.limit),
    },
  });
}
