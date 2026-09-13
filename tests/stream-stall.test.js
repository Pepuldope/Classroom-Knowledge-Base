import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, routeChat, awaitFirstData, resetRouterHealth } from "../api/ai-router.js";
import { tutorEventStream } from "../api/tutor.js";
import { createDeltaStream } from "../chat-ux.js";

// Live, 2026-09-13: OpenRouter accepted a tutor request for
// nemotron-3-ultra:free with HTTP 200, then sent nothing but
// ": OPENROUTER PROCESSING" keep-alives for minutes. The router had already
// committed on the 200, so no other model was tried, and the student got an
// empty reply bubble with no way to retry.

const enc = new TextEncoder();

/** A stream that emits these strings, then either closes or hangs open. */
function sseStream(parts, { close = true, gapMs = 0 } = {}) {
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      for (const part of parts) {
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
        if (cancelled) return;
        controller.enqueue(enc.encode(part));
      }
      if (close) controller.close();
    },
    cancel() { cancelled = true; },
  });
  return { stream, wasCancelled: () => cancelled };
}

async function readAll(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

const KEEPALIVE = ": OPENROUTER PROCESSING\n\n";
const delta = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

test("a stream that only sends keep-alives is reported stalled, and cancelled", async () => {
  const s = sseStream([KEEPALIVE, KEEPALIVE], { close: false });
  const t0 = Date.now();
  const first = await awaitFirstData(s.stream, 60);
  assert.equal(first.ok, false);
  assert.equal(first.reason, "stalled");
  assert.ok(Date.now() - t0 < 1000, "the wait must end at the deadline, not when the stream does");
  assert.equal(s.wasCancelled(), true, "a stalled upstream must be released, not left streaming");
});

test("a stream that closes without a data line is reported empty", async () => {
  const s = sseStream([KEEPALIVE]);
  const first = await awaitFirstData(s.stream, 1000);
  assert.equal(first.ok, false);
  assert.equal(first.reason, "empty");
});

test("once data arrives, every byte is replayed, keep-alives included", async () => {
  const parts = [KEEPALIVE, delta("Hel"), delta("lo"), "data: [DONE]\n\n"];
  const s = sseStream(parts, { gapMs: 5 });
  const first = await awaitFirstData(s.stream, 1000);
  assert.equal(first.ok, true);
  assert.equal(await readAll(first.stream), parts.join(""));
});

test("reasoning tokens count as data: a thinking model is not stalled", async () => {
  const reasoning = `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "hmm" } }] })}\n\n`;
  const s = sseStream([reasoning], { close: false });
  const first = await awaitFirstData(s.stream, 1000);
  assert.equal(first.ok, true);
});

test("the router skips a model that stalls after HTTP 200 and serves the next one", async (t) => {
  const saved = PROVIDERS.map((p) => p.apiKey);
  for (const p of PROVIDERS) p.apiKey = undefined;
  PROVIDERS.push({ name: "stalltest", baseURL: "http://stall.test/v1", apiKey: "k", models: ["m-stall", "m-ok"], effort: 2 });
  const stalled = sseStream([KEEPALIVE], { close: false });
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, opts) => {
    const { model } = JSON.parse(opts.body);
    asked.push(model);
    const body = model === "m-stall" ? stalled.stream : sseStream([delta("answer")]).stream;
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    PROVIDERS.pop();
    PROVIDERS.forEach((p, i) => { p.apiKey = saved[i]; });
    resetRouterHealth();
  });

  const routed = await routeChat([{ role: "user", content: "hi" }], { task: "tutor", stream: true, firstDataMs: 60 });
  assert.deepEqual(asked, ["m-stall", "m-ok"]);
  assert.equal(routed.model, "m-ok");
  assert.equal(stalled.wasCancelled(), true);
  assert.match(await readAll(routed.stream), /answer/);
});

test("when every model stalls, the router throws instead of serving silence", async (t) => {
  const saved = PROVIDERS.map((p) => p.apiKey);
  for (const p of PROVIDERS) p.apiKey = undefined;
  PROVIDERS.push({ name: "stalltest", baseURL: "http://stall.test/v1", apiKey: "k", models: ["a", "b"], effort: 2 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseStream([KEEPALIVE], { close: false }).stream, { status: 200 });
  t.after(() => {
    globalThis.fetch = realFetch;
    PROVIDERS.pop();
    PROVIDERS.forEach((p, i) => { p.apiKey = saved[i]; });
    resetRouterHealth();
  });

  await assert.rejects(
    routeChat([{ role: "user", content: "hi" }], { task: "tutor", stream: true, firstDataMs: 40 }),
    /no data/,
  );
});

// Routing now waits on the first token, which can take longer than Vercel
// allows before a response must START (25s on the edge). So the tutor answers
// at once and routes inside the stream, naming the model in a control event.

test("the tutor stream leads with sources, names the model, then relays the answer", async () => {
  const stream = tutorEventStream({
    sourcesEvent: 'data: {"type":"sources","notes":[]}\n\n',
    route: async () => ({ provider: "openrouter", model: "m-ok", stream: sseStream([delta("hi")]).stream, meta: { attempts: 2 } }),
  });
  let sources = null, route = null, acc = "";
  const events = createDeltaStream({
    onSources: (n) => { sources = n; },
    onRoute: (r) => { route = r; },
    onContent: (c) => { acc += c; },
  });
  events.push(await readAll(stream));
  events.end();
  assert.deepEqual(sources, []);
  assert.equal(route.model, "m-ok");
  assert.equal(route.provider, "openrouter");
  assert.equal(acc, "hi");
});

test("a routing failure arrives as an error event, not a silent empty stream", async () => {
  const stream = tutorEventStream({
    sourcesEvent: 'data: {"type":"sources","notes":[]}\n\n',
    route: async () => { throw new Error("All AI providers failed: openrouter a sent no data in 20s"); },
  });
  let error = null;
  const events = createDeltaStream({ onError: (e) => { error = e; } });
  const raw = await readAll(stream);
  events.push(raw);
  events.end();
  assert.match(error, /All AI providers failed/);
  assert.match(raw, /data: \[DONE\]/);
});
