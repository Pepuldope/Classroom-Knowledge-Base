import { verifyUser, checkAndIncrementRate, jsonResponse } from "./_helpers.js";
// Shared with the client so the two cannot drift — the prompt, the server
// validation and the client fallback previously each carried their own list.
import { TASK_KINDS, normalizeTaskKind } from "../task-kinds.js";
// The rest of the site's AI already rotates across NVIDIA / Gemini / Groq /
// Mistral / Cerebras / GitHub / Qwen / FreeLLMAPI / OpenRouter with circuit
// breakers and RPM caps. Enrichment was the one flow that never used it: it
// was pinned to OpenRouter's free tier, so a bad afternoon on shared free
// capacity was a total outage for it, however healthy the other eight keys
// were. The chain below is still tried first — it is free and its answers are
// cached — and the router now catches what falls through it.
import { completeChat } from "./ai-router.js";

export const config = { runtime: "edge" };

// Models are OpenRouter ids and they DO get retired — an earlier pair
// (nvidia/nemotron-3-nano-30b-a3b:free, nvidia/nemotron-nano-9b-v2:free) was
// removed from the catalogue, after which every call 400'd. Check
// https://openrouter.ai/api/v1/models before assuming the code is at fault.
//
// A CHAIN, not a pair. OpenRouter's :free models are served by shared
// capacity, and the popular ones answer 429 "temporarily rate-limited
// upstream" for minutes at a time — one backup is not enough, because the
// second most popular model is congested for the same reason as the first.
// Ordered cheapest-to-reach first, and deliberately mixing vendors so a chain
// of 429s is unlikely to be correlated. The less-trafficked entries at the
// end are the ones that tend to answer when the well-known ones will not.
// Every entry is verified against https://openrouter.ai/api/v1/models by
// `scripts/enrich_models_test.mjs`: the id must still exist AND must advertise
// `response_format`, because the request below sends
// `provider: { require_parameters: true }` — a model that does not implement
// structured output is not merely worse here, it is unroutable.
//
// Two links failed that check on 2026-09-09 and are gone:
//   minimax/minimax-m2.7:free        retired from OpenRouter — can only 404
//   nvidia/nemotron-3.5-lightning    does not advertise response_format
//
// Ordered INSTRUCT-first, not most-capable-first. Leading with the 120B
// reasoning model was a mistake made on 2026-09-09 and reported the same day:
// it ignores `reasoning: { exclude: true }` on its free provider and thinks in
// the content channel, so it answered with "We need to output JSON with fields
// weight, actionType, …" and spent the token budget before reaching an object.
// Raw capability is worth nothing here if the reply is not parseable; an
// instruct model that reliably emits the object beats a cleverer one that
// narrates. The reasoner stays as a mid-chain fallback.
//
// The tail matters too. It used to end on `liquid/lfm-2.5-2.6b:free` — 2.6B
// parameters, asked for a JSON object — which returned nothing whenever the
// chain reached it, so "liquid/lfm-2.5-2.6b:free: empty completion" was the
// only thing a user ever saw. A last resort that cannot do the job is not a
// last resort.
//
// Free slugs are retired often; re-run that script when this chain misbehaves.
const MODEL_CHAIN = [
  "google/gemma-4-31b-it:free",
  "nex-agi/nex-n2.5-pro:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "dots-studio/dots-3-note-preview:free",
];

/**
 * A 429 means one of two very different things, and treating them alike is
 * why this used to give up on the first refusal:
 *   - the account/key is over its own limit  -> every :free model is closed,
 *     stop and report it.
 *   - one model's upstream provider is busy  -> a DIFFERENT model will work,
 *     so carry on down the chain.
 * OpenRouter words the second case as "temporarily rate-limited upstream" /
 * "Provider returned error".
 */
const ACTION_TYPES = ["submit_online", "in_person", "study_only", "read_only"];

/**
 * Pull a JSON object out of a completion.
 *
 * A model told to answer with JSON may still wrap it in a ```json fence or
 * front it with a "Here's a thinking process:" preamble. The previous greedy
 * /\{[\s\S]*\}/ match spanned from the first brace in that prose to the last
 * one anywhere in the text, which is usually not a valid object. Scan for
 * balanced objects instead and take the last one that parses — the answer
 * comes after the reasoning, not before it.
 */
/**
 * Walk a model chain and return the first answer that actually parses.
 *
 * Separated out and exported because the bug it fixes is a control-flow bug,
 * and control flow buried inside a fetch handler can only be tested by having
 * a live OpenRouter key and a model that misbehaves on the day you run it.
 *
 * `call` returns raw text or null; `parse` returns an object or null; `stop`
 * says when to abandon the chain entirely (an account-level quota closes every
 * door, whereas one busy provider says nothing about the next model).
 */
export async function firstParsableAnswer(chain, { call, parse, onUnparsable = () => {}, stop = () => false } = {}) {
  for (const model of Array.isArray(chain) ? chain : []) {
    const raw = await call(model);
    if (raw) {
      const value = parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) return { model, value, raw };
      onUnparsable(model, raw);
    }
    if (stop()) break;
  }
  return null;
}

export function parseModelJson(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/```(?:json)?/gi, "");
  try { return JSON.parse(text.trim()); } catch {}
  const candidates = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth += 1; }
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) { candidates.push(text.slice(start, i + 1)); start = -1; }
      if (depth < 0) { depth = 0; start = -1; }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(candidates[i]);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {}
  }
  return null;
}

function isAccountRateLimited(status, body) {
  if (status !== 429) return false;
  return !/upstream|provider returned error/i.test(body || "");
}

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const SYSTEM_PROMPT = `You analyze a Google Classroom assignment and return JSON. Judge these five fields:

- weight (1-5): importance + effort. 1=trivial, 3=normal homework, 5=major exam/project.
- actionType: determined by what the student must DO, not by workType. One of:
  * "submit_online" — student must UPLOAD/TURN IN a deliverable through Classroom (essay, document, photo of work, code, completed Google Doc/Form). Description usually says "upload", "submit", "turn in", "odovzdaj", "nahraj", or attaches a Doc/Slides for the student to fill in and submit.
  * "in_person" — assessment happens IN CLASS with no upload (test, quiz, exam, presentation, oral exam, lab demo, písomka, skúška, kvíz, prezentácia, vstupný test, ústna skúška). Any task whose name or description suggests an in-class evaluation is in_person, even if Classroom shows it as a generic assignment.
  * "study_only" — preparation work for a future lesson. Read in advance, prepare to discuss, study for an upcoming quiz, work in a paper notebook, bring something to next class. Description mentions "prepare for", "pripravte sa", "na ďalšiu hodinu", "do zošita", "bring to class", "we will discuss", or asks for prep with no upload mechanism.
  * "read_only" — passive reading material, announcement, FYI post. No real task expected.

  TIEBREAKER: if the description does NOT explicitly tell the student to UPLOAD or TURN IN something, prefer "study_only" or "in_person" over "submit_online". Don't assume submission just because Classroom shows it as an assignment.
- taskKind: ONE specific noun describing what this assignment IS. Pick the MOST SPECIFIC from this list and use NOTHING else: ${TASK_KINDS.map((k) => `"${k}"`).join(", ")}. Always English, always exactly as spelled above. NEVER use generic words like "Assignment", "Task", "Homework", "Work" or "Question" — those name the format, not the work, and tell the student nothing. If genuinely unclear, pick the closest specific kind.
- estimatedMinutes: realistic minutes a student needs. ALWAYS REQUIRED — return a positive integer, never null, never 0, never omit. Be CONSERVATIVE: homework 10-30, worksheets 15-25, essays 45-90, big projects 120-240, in-person tests 30-60 (for study time), quick readings 10-20. If genuinely unsure, default to 20.
- oneLineSummary: under 90 chars, plain description of what to do. IN THE SAME LANGUAGE AS THE ASSIGNMENT. Never translate. Use ONLY real existing words in that language — if you're unsure how to phrase something in Slovak (or whatever the language is), use simpler vocabulary you are 100% confident is correct. NEVER invent words, NEVER mix languages within a sentence, NEVER conjugate foreign verbs with native endings. When possible, reuse phrasing from the assignment description itself rather than paraphrasing.

Respond with ONLY this JSON, no prose:
{"weight":3,"actionType":"submit_online","taskKind":"Worksheet","estimatedMinutes":30,"oneLineSummary":"..."}`;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.result || null;
  } catch { return null; }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      body: value,
    });
  } catch {}
}

/**
 * Last resort: the shared multi-provider router.
 *
 * `requires: ["json"]` is not decoration — routeChat drops every provider
 * without that capability rather than silently routing to one that will answer
 * in prose, which is the failure mode this whole file is built around. `quick`
 * keeps it on the cheap tier and lets the router escalate a tier if that band
 * is exhausted. Any throw here means every provider is down, which is a
 * genuine failure and belongs in the reported detail alongside the chain's.
 */
async function routerAttempt(userMsg, noteFailure) {
  try {
    const r = await completeChat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      { task: "quick", requires: ["json"], max_tokens: 2000, temperature: 0.2 },
    );
    const value = parseModelJson(r?.text || "");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { model: `${r.meta?.provider || "router"}:${r.meta?.model || ""}`, value, raw: r.text };
    }
    noteFailure(`router(${r?.meta?.provider || "?"}): prose, not JSON: ${String(r?.text || "").slice(0, 120)}`);
  } catch (e) {
    noteFailure(`router: ${e?.message || "all providers failed"}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Work that happens in the room, and what it actually is.
//
// Two different questions were being answered by one keyword list, and the
// second answer was wrong. Everything here — "test", but also "na hodine",
// "in class", "lab demo" — marked an assignment as done IN PERSON, which is
// right. It then forced the KIND, and the else-branch of that force was
// "Test". So a worksheet whose description said it would be done in class came
// back as a Test, and a test the student did not have appeared on the Planner.
// Peter, 2026-09-16: "It miscategorized a worksheet homework as a test."
//
// Where the work happens and what the work is are now separate lists. A place
// word still makes it in-person; only an assessment word may call it a Test.
// ---------------------------------------------------------------------------

/** Names an assessment: the work IS the thing being marked. */
export const ASSESSMENT_WORDS = [
  "test", "tests", "exam", "exams", "midterm", "final",
  "písomka", "pisomka", "písomky", "pisomky",
  "skúška", "skuska", "skúšanie", "skusanie", "skúšky", "skusky",
  "previerka", "previerky",
  "diktát", "diktat",
  "vstupný test", "vstupny test", "výstupný test", "vystupny test",
  "písomné skúšanie", "pisomne skusanie",
  "maturita", "maturity",
];

/** Assessments that are specifically a quiz. */
export const QUIZ_WORDS = ["quiz", "quizzes", "kvíz", "kviz", "kvízu", "kvizu"];

/** Assessments delivered by speaking. */
export const PRESENTATION_WORDS = [
  "presentation", "oral", "viva",
  "prezentácia", "prezentacia", "prezentácie", "prezentacie",
  "ústna skúška", "ustna skuska", "ústne", "ustne",
];

/**
 * Says only WHERE the work happens. These never change the kind: a worksheet
 * done in class is a worksheet.
 */
export const IN_PERSON_PLACE_WORDS = ["in-class", "in class", "lab demo", "v triede", "na hodine", "v škole", "v skole"];

export const SUBMIT_WORDS = [
  // explicit upload/turn-in verbs
  "upload", "submit", "turn in", "turned in", "hand in",
  "attach", "attached file", "google doc", "google form",
  "odovzdaj", "odovzdajte", "odovzdať", "odovzdat",
  "nahraj", "nahrajte", "nahrať", "nahrat",
  "vlož", "vloz", "vložte", "vlozte",
  "pošli", "posli", "pošlite", "poslite", "pošlite mi", "poslite mi",
  "send the file", "submit your", "upload your",
];

// Word-boundary keyword matcher. Some keywords are multi-word; treat as
// substrings, others as standalone words to avoid false matches like
// "test yourself" / "contest".
export function hasWord(text, words) {
  const value = String(text || "");
  return words.some((w) => {
    if (w.includes(" ")) return value.includes(w);
    return new RegExp(`(^|[^\\p{L}\\p{N}])${w}([^\\p{L}\\p{N}]|$)`, "u").test(value);
  });
}

/**
 * @returns the fields to override on the parsed enrichment — `actionType`
 *          always when the work happens in person, `taskKind` only when an
 *          assessment word says what it is.
 */
export function inPersonDecision({ title = "", desc = "", taskKind = "" } = {}) {
  // Lowercased here rather than trusted from the caller: the word lists are
  // lowercase, and "Písomka" in a title is how a title is actually written.
  const t = String(title || "").toLowerCase();
  const d = String(desc || "").toLowerCase();
  const all = [ASSESSMENT_WORDS, QUIZ_WORDS, PRESENTATION_WORDS, IN_PERSON_PLACE_WORDS].flat();
  const hasSubmitSignal = hasWord(`${t} ${d}`, SUBMIT_WORDS);

  // WHERE the work happens: the title, or a description that does not also ask
  // for a file. This is the question the list was written for.
  const happensInPerson = hasWord(t, all) || (hasWord(d, all) && !hasSubmitSignal);
  if (!happensInPerson) return {};

  const out = { actionType: "in_person" };
  // Kinds that already describe an in-class assessment are left alone.
  if (!taskKind || /^(Test|Quiz|Presentation)$/i.test(taskKind)) return out;

  // WHAT the work is: the TITLE only. A description mentioning an assessment
  // is usually mentioning a DIFFERENT one — "prepare for the test on Friday"
  // is the most ordinary sentence on a homework worksheet, and reading it as
  // "this is a test" puts an exam on the Planner that does not exist. This
  // override is a backstop under the model, which reads the whole text; when
  // an assignment really is an assessment, teachers say so in the title.
  if (hasWord(t, PRESENTATION_WORDS)) out.taskKind = "Presentation";
  else if (hasWord(t, QUIZ_WORDS)) out.taskKind = "Quiz";
  else if (hasWord(t, ASSESSMENT_WORDS)) out.taskKind = "Test";
  // else: it happens in the room, and it is still whatever the model called it.
  return out;
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "OPENROUTER_API_KEY not configured" }), { status: 500 });
  }

  const sub = await verifyUser(req);
  if (!sub) return jsonResponse({ error: "unauthorized" }, 401);

  const rate = await checkAndIncrementRate(sub);
  if (!rate.ok) {
    return jsonResponse({ error: "rate_limited", count: rate.count, limit: rate.limit }, 429);
  }

  let body;
  try { body = await req.json(); } catch { body = null; }
  if (!body || !Array.isArray(body.assignments) || body.assignments.length === 0) {
    return new Response(JSON.stringify({ error: "assignments array required" }), { status: 400 });
  }

  const results = await Promise.all(body.assignments.slice(0, 5).map(async (a) => {
    let lastFailure = "";
    let quotaExhausted = false;
    const hash = a.contentHash || "";
    const PROMPT_VERSION = "v5";
    const cacheKey = `enrich:${PROMPT_VERSION}:${a.id}:${hash}`;
    const cached = await kvGet(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.taskKind && Number.isFinite(parsed.estimatedMinutes) && parsed.estimatedMinutes > 0) {
          // Normalize on the way out as well as on the way in. Entries stored
          // before the canonical list was enforced can hold kinds that are no
          // longer valid — "Question" among them — and returning them
          // unchecked meant the fix never reached anything already cached.
          const cachedHaystack = `${a.title || ""} ${(a.description || "").slice(0, 400)}`.toLowerCase();
          return { id: a.id, ...parsed, taskKind: normalizeTaskKind(parsed.taskKind, cachedHaystack) };
        }
      } catch {}
    }

    const userMsg = `Course: ${a.courseName}\nTitle: ${a.title}\nWork type: ${a.workType || "ASSIGNMENT"}\nDescription: ${(a.description || "").slice(0, 250)}`;

    // Every link's reason, not just the last one's. Reporting only the last
    // was actively misleading: when three capable models were rate-limited and
    // the chain fell through, the message a user saw named the smallest model
    // in the list and said "empty completion" — which pointed the reader at the
    // one link that was never going to work anyway, and hid the quota.
    const failures = [];
    const noteFailure = (detail) => {
      failures.push(detail);
      lastFailure = failures.join(" | ");
    };

    const callModel = async (model) => {
      try {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://classroom-knowledge.vercel.app",
            "X-Title": "Classroom Knowledge Base",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMsg },
            ],
            response_format: { type: "json_object" },
            // Only route to providers that actually implement the parameters
            // above. Without this OpenRouter is free to pick a provider that
            // ignores response_format, and the model answers with prose.
            provider: { require_parameters: true },
            // Reasoning models spend the budget thinking before they emit
            // anything. Turn it off where supported, and leave enough room
            // that a model which thinks anyway still reaches the JSON —
            // 400 tokens was consumed entirely by a thinking preamble, so
            // the response was cut off before any object was produced.
            reasoning: { exclude: true },
            // 1200 was enough for the object but not for a thinking preamble
            // plus the object, and some free providers ignore the `reasoning`
            // flag above. The chain falls through on prose either way now;
            // this just means fewer models need to.
            max_tokens: 2000,
            temperature: 0.2,
          }),
        });
        if (!r.ok) {
          // Keep why. Throwing this away is what made a dead model, an empty
          // quota and a malformed key all look like the same silent nothing.
          const body = await r.text().catch(() => "");
          noteFailure(`${model}: HTTP ${r.status} ${body.slice(0, 200)}`);
          if (isAccountRateLimited(r.status, body)) quotaExhausted = true;
          return null;
        }
        const data = await r.json().catch(() => null);
        const content = data?.choices?.[0]?.message?.content || null;
        if (!content) noteFailure(`${model}: empty completion`);
        return content;
      } catch (e) {
        noteFailure(`${model}: ${e.name || "fetch failed"}`);
        return null;
      }
    };

    // Parse INSIDE the loop. This used to break on the first model that
    // answered at all, then parse once, and give up if that answer was prose —
    // so a reasoning model that thinks out loud in the content channel ended
    // the chain on behalf of four models that were never asked.
    // (Reported 2026-09-09: "nvidia/nemotron-3-super-120b-a12b:free did not
    // return JSON: We need to output JSON with fields weight, actionType…".)
    // A link only counts when it produces something usable.
    let attempt = await firstParsableAnswer(MODEL_CHAIN, {
      call: callModel,
      parse: parseModelJson,
      onUnparsable: (model, raw) => noteFailure(`${model}: prose, not JSON: ${String(raw).slice(0, 120)}`),
      stop: () => quotaExhausted,
    });
    // Every free OpenRouter link is spent. Before telling the user the AI
    // could not analyze their assignment, ask the eight other providers.
    if (!attempt) attempt = await routerAttempt(userMsg, noteFailure);
    if (!attempt) return { id: a.id, error: "ai_failed", detail: lastFailure };
    const { value: parsed } = attempt;

    const minutes = Number(parsed.estimatedMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) parsed.estimatedMinutes = 20;
    // A model that decides an essay takes 4000 minutes is not useful either.
    else parsed.estimatedMinutes = Math.min(600, Math.max(5, Math.round(minutes)));

    const weight = Number(parsed.weight);
    parsed.weight = Number.isFinite(weight) ? Math.min(5, Math.max(1, Math.round(weight))) : 3;

    if (!ACTION_TYPES.includes(parsed.actionType)) parsed.actionType = "study_only";

    const title = (a.title || "").toLowerCase();
    const desc = (a.description || "").slice(0, 400).toLowerCase();
    const haystack = `${title} ${desc}`;

    parsed.taskKind = normalizeTaskKind(parsed.taskKind, haystack);
    Object.assign(parsed, inPersonDecision({ title, desc, taskKind: parsed.taskKind }));

    if (hash) await kvSet(cacheKey, JSON.stringify(parsed));
    return { id: a.id, ...parsed };
  }));

  // Failed entries travel too. Dropping them here is what made every
  // enrichment failure silent: the reason was assembled per assignment and
  // then discarded one line before the response, so the client saw an empty
  // array and could only report that nothing came back. The client skips
  // caching anything carrying `error` and reports it, so passing them through
  // is what lets a cause reach the user at all.
  const enrichments = results.filter(Boolean);
  const failures = enrichments.filter((r) => r.error).length;
  return new Response(JSON.stringify({ enrichments, failures }), {
    headers: { "Content-Type": "application/json" },
  });
}
