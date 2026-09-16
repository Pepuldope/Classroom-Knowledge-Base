// What actually happens to a request carrying the student's own key.
//
// The first gate for this feature mocked /api/tutor, so it proved the key left
// the browser and nothing more. It could not have caught either of the two
// things that made the feature not work:
//
//   - the daily limit was charged and enforced BEFORE routing, so a student who
//     had run out of free requests got a 429 even with their own key — which is
//     the one moment anybody bothers to paste one;
//   - nothing had ever confirmed the router builds a real request from a BYOK
//     entry: the right endpoint, the right Authorization header, the right
//     model.
//
// So this drives routeChat with fetch stubbed, and asserts the request.
import test from "node:test";
import assert from "node:assert/strict";

// PROVIDERS is built from the environment when the module loads, and a shared
// provider with no key is not in the chain at all. Without one there is nothing
// for a dead key to fall back TO, so the fallback assertions below would pass
// vacuously — or, as they first did, fail with "No AI providers configured".
// Set before the import, which is why this one is dynamic.
process.env.OPENROUTER_API_KEY ||= "shared-test-key";
const { routeChat, BYOK_PROVIDERS } = await import("../api/ai-router.js");

const MINE = { provider: "groq", apiKey: "gsk_mine", model: "llama-3.3-70b-versatile" };

/** Stub fetch; `respond(call)` decides each response. Returns the call log. */
function stubFetch(respond) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const call = {
      url: String(url),
      auth: opts.headers?.Authorization,
      model: opts.body ? JSON.parse(opts.body).model : null,
    };
    calls.push(call);
    return respond(call);
  };
  calls.restore = () => { globalThis.fetch = real; };
  return calls;
}

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "ready" } }] }),
  { status: 200, headers: { "Content-Type": "application/json" } });
const dead = () => new Response(JSON.stringify({ error: "invalid api key" }), { status: 401 });

test("the student's key is used, against the provider's real endpoint", async () => {
  const calls = stubFetch(ok);
  try {
    const r = await routeChat([{ role: "user", content: "hi" }], {
      task: "tutor", stream: false, classify: false, byok: MINE,
    });
    assert.equal(r.provider, "yours:groq");
    assert.equal(r.model, "llama-3.3-70b-versatile");
    assert.equal(calls.length, 1, "the shared chain was consulted as well");
    assert.equal(calls[0].url, BYOK_PROVIDERS.groq.baseURL);
    assert.equal(calls[0].auth, "Bearer gsk_mine");
    assert.equal(calls[0].model, "llama-3.3-70b-versatile");
  } finally { calls.restore(); }
});

test("the student's key is tried FIRST, before any shared provider", async () => {
  const calls = stubFetch(ok);
  try {
    await routeChat([{ role: "user", content: "hi" }], { task: "tutor", stream: false, classify: false, byok: MINE });
    assert.equal(calls[0].auth, "Bearer gsk_mine", "something else answered before their key");
  } finally { calls.restore(); }
});

test("a dead key falls back to the shared chain rather than failing", async () => {
  // Peter's call: a key that expires or is mistyped costs one slow answer, not
  // a dead tutor.
  const calls = stubFetch((call) => (call.auth === "Bearer gsk_mine" ? dead() : ok()));
  try {
    const r = await routeChat([{ role: "user", content: "hi" }], {
      task: "tutor", stream: false, classify: false, byok: MINE,
    });
    assert.ok(calls.length >= 2, "nothing was tried after the dead key");
    assert.equal(calls[0].auth, "Bearer gsk_mine");
    assert.ok(!r.provider.startsWith("yours:"), "the dead key reported success");
  } finally { calls.restore(); }
});

test("sharedFallback:false means their key or nothing", async () => {
  // What a student past the daily limit gets: their own key still works, and a
  // failure is an error they can see rather than a silent charge against an
  // allowance they have already spent.
  const calls = stubFetch(dead);
  try {
    await assert.rejects(
      routeChat([{ role: "user", content: "hi" }], {
        task: "tutor", stream: false, classify: false, byok: MINE, sharedFallback: false,
      }),
      /All AI providers failed/,
    );
    assert.equal(calls.length, 1, "the shared chain was used despite sharedFallback:false");
    assert.equal(calls[0].auth, "Bearer gsk_mine");
  } finally { calls.restore(); }
});

test("no key means nothing changes", async () => {
  const calls = stubFetch(ok);
  try {
    const r = await routeChat([{ role: "user", content: "hi" }], { task: "tutor", stream: false, classify: false });
    assert.ok(!r.provider.startsWith("yours:"));
    assert.ok(calls.every((c) => c.auth !== "Bearer gsk_mine"));
  } finally { calls.restore(); }
});

test("an unusable key is ignored rather than tried", async () => {
  const calls = stubFetch(ok);
  try {
    const r = await routeChat([{ role: "user", content: "hi" }], {
      task: "tutor", stream: false, classify: false, byok: { provider: "nope", apiKey: "x" },
    });
    assert.ok(!r.provider.startsWith("yours:"), "an unknown provider was routed to");
  } finally { calls.restore(); }
});

// --- who pays ---------------------------------------------------------------

const { tutorRatePolicy } = await import("../api/tutor.js");

test("a student with no key of their own is charged exactly as before", () => {
  assert.deepEqual(tutorRatePolicy({ hasOwnKey: false, overLimit: false }),
    { refuse: false, chargeUpFront: true, chargeIfShared: false, sharedFallback: true });
  assert.equal(tutorRatePolicy({ hasOwnKey: false, overLimit: true }).refuse, true);
});

test("their own key is not refused for the shared key's allowance", () => {
  // THE BUG. The limit protects the shared key; charging it up front refused
  // requests it was not paying for, at the one moment a key is worth pasting.
  const spent = tutorRatePolicy({ hasOwnKey: true, overLimit: true });
  assert.equal(spent.refuse, false, "a student with their own key was refused");
  assert.equal(spent.chargeUpFront, false);
  assert.equal(spent.chargeIfShared, false, "an allowance already spent was charged again");
  assert.equal(spent.sharedFallback, false, "a spent shared chain was still offered as a fallback");
});

test("under the limit, the shared allowance is spent only if the shared chain answers", () => {
  const fine = tutorRatePolicy({ hasOwnKey: true, overLimit: false });
  assert.equal(fine.chargeUpFront, false, "their key was charged before anyone answered");
  assert.equal(fine.chargeIfShared, true);
  assert.equal(fine.sharedFallback, true, "their key lost its safety net");
});

test("the policy never both refuses and charges", () => {
  for (const hasOwnKey of [true, false]) {
    for (const overLimit of [true, false]) {
      const p = tutorRatePolicy({ hasOwnKey, overLimit });
      assert.ok(!(p.refuse && p.chargeUpFront), `refused and charged: ${hasOwnKey}/${overLimit}`);
      assert.ok(!(p.chargeUpFront && p.chargeIfShared), "charged twice");
      if (!p.sharedFallback) assert.equal(p.chargeIfShared, false, "charged for a chain it cannot use");
    }
  }
});
