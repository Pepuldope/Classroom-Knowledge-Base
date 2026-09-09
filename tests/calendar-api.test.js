// The Calendar calls, with the network faked. The branches that matter are the
// ones a person would otherwise only find in production.
import test from "node:test";
import assert from "node:assert/strict";
import { createCalendarClient, MANAGED_QUERY } from "../calendar-api.js";
import { CALENDAR_SUMMARY } from "../calendar-consent.js";

/** A fake `request` driven by a table of responses, recording every call. */
function fakeRequest(handlers = {}) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path.split("?")[0]}`;
    const handler = handlers[key] ?? handlers[method];
    if (typeof handler === "function") return handler({ method, path, body, calls });
    if (handler === undefined) return {};
    return handler;
  };
  return { request, calls };
}
const httpError = (status) => { const e = new Error(`HTTP ${status}`); e.status = status; return e; };

test("with no calendar id, one is created and handed back", async () => {
  const created = [];
  const { request, calls } = fakeRequest({ "POST /calendars": { id: "cal-new" } });
  const client = createCalendarClient({ request, timeZone: "Europe/Bratislava" });
  const id = await client.ensureCalendar("", { onCreate: (v) => created.push(v) });

  assert.equal(id, "cal-new");
  assert.deepEqual(created, ["cal-new"], "the caller gets to persist it");
  assert.equal(calls[0].body.summary, CALENDAR_SUMMARY);
  assert.equal(calls[0].body.timeZone, "Europe/Bratislava");
});

test("an existing calendar is verified, not recreated", async () => {
  const { request, calls } = fakeRequest({ "GET /calendars/cal-1": { id: "cal-1" } });
  const client = createCalendarClient({ request });
  assert.equal(await client.ensureCalendar("cal-1"), "cal-1");
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "no second calendar");
});

test("a calendar the student deleted is recreated instead of wedging", async () => {
  // Without this, every write 404s forever and the feature looks broken with
  // no way back short of clearing site data.
  const { request } = fakeRequest({
    "GET /calendars/gone": () => { throw httpError(404); },
    "POST /calendars": { id: "cal-2" },
  });
  const client = createCalendarClient({ request });
  assert.equal(await client.ensureCalendar("gone"), "cal-2");
});

test("a failure that is NOT 'gone' must never spawn a duplicate calendar", async () => {
  // A 401 or a 500 means try again later, not "make another one" — otherwise a
  // bad token during a network blip litters the account with calendars.
  const { request, calls } = fakeRequest({ "GET /calendars/cal-1": () => { throw httpError(401); } });
  const client = createCalendarClient({ request });
  await assert.rejects(() => client.ensureCalendar("cal-1"), /401/);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("only events we created are ever listed", async () => {
  const { request, calls } = fakeRequest({ "GET /calendars/cal-1/events": { items: [{ id: "a" }] } });
  const client = createCalendarClient({ request });
  const events = await client.listManagedEvents("cal-1");
  assert.deepEqual(events.map((e) => e.id), ["a"]);
  assert.ok(calls[0].path.includes(`privateExtendedProperty=${encodeURIComponent(MANAGED_QUERY)}`),
    "the filter is server-side, so a student's own events are never even fetched");
});

test("paging is followed to the end", async () => {
  let page = 0;
  const { request } = fakeRequest({
    "GET /calendars/cal-1/events": () => (page++ === 0
      ? { items: [{ id: "a" }], nextPageToken: "p2" }
      : { items: [{ id: "b" }] }),
  });
  const events = await createCalendarClient({ request }).listManagedEvents("cal-1");
  assert.deepEqual(events.map((e) => e.id), ["a", "b"]);
});

test("a server that keeps handing back the same page cannot spin forever", async () => {
  const { request, calls } = fakeRequest({
    "GET /calendars/cal-1/events": { items: [{ id: "a" }], nextPageToken: "same" },
  });
  const events = await createCalendarClient({ request }).listManagedEvents("cal-1");
  assert.ok(calls.length <= 40, `stopped after ${calls.length} pages`);
  assert.ok(events.length > 0);
});

test("creating an event that already exists patches it instead of duplicating", async () => {
  // Two devices syncing at once, or a run that wrote the event and failed to
  // record it. Ids are deterministic, so the right answer is always to patch.
  const { request, calls } = fakeRequest({
    "POST /calendars/cal-1/events": () => { throw httpError(409); },
    "PATCH /calendars/cal-1/events/ck1": {},
  });
  const client = createCalendarClient({ request });
  const result = await client.applyOp("cal-1", { op: "create", id: "ck1", body: { id: "ck1" } });
  assert.equal(result.result, "patched");
  assert.equal(result.note, "already existed");
  assert.equal(calls.filter((c) => c.method === "POST").length, 1, "exactly one attempt, not a retry loop");
});

test("deleting something already gone is success", async () => {
  for (const status of [404, 410]) {
    const { request } = fakeRequest({ "DELETE /calendars/cal-1/events/ck1": () => { throw httpError(status); } });
    const result = await createCalendarClient({ request }).applyOp("cal-1", { op: "delete", id: "ck1" });
    assert.equal(result.result, "deleted");
    assert.equal(result.note, "already gone");
  }
});

test("one bad event does not abandon the rest of the plan", async () => {
  const { request } = fakeRequest({
    "POST /calendars/cal-1/events": ({ body }) => {
      if (body.id === "bad") throw httpError(400);
      return {};
    },
  });
  const client = createCalendarClient({ request });
  const { done, failed } = await client.applyPlan("cal-1", [
    { op: "create", id: "ck1", body: { id: "ck1" } },
    { op: "create", id: "bad", body: { id: "bad" } },
    { op: "create", id: "ck2", body: { id: "ck2" } },
  ]);
  assert.deepEqual(done.map((d) => d.id), ["ck1", "ck2"], "the good ones still land");
  assert.deepEqual(failed.map((f) => f.id), ["bad"]);
  assert.match(failed[0].error, /400/, "and the caller is told why");
});

test("skips cost no requests at all, so a daily sync is free", async () => {
  const { request, calls } = fakeRequest();
  const client = createCalendarClient({ request });
  const { done } = await client.applyPlan("cal-1", [
    { op: "skip", id: "ck1", reason: "unchanged" },
    { op: "skip", id: "ck2", reason: "edited by the student" },
  ]);
  assert.equal(calls.length, 0);
  assert.deepEqual(done.map((d) => d.result), ["skipped", "skipped"]);
});

test("the switch hides and unhides; only the button deletes", async () => {
  const { request, calls } = fakeRequest();
  const client = createCalendarClient({ request });
  await client.setVisibility("cal-1", false);
  assert.equal(calls[0].method, "PATCH");
  assert.match(calls[0].path, /users\/me\/calendarList\/cal-1/);
  assert.deepEqual(calls[0].body, { hidden: true, selected: false });

  await client.setVisibility("cal-1", true);
  assert.deepEqual(calls[1].body, { hidden: false, selected: true });

  await client.deleteCalendar("cal-1");
  assert.equal(calls[2].method, "DELETE");
  assert.equal(calls[2].path, "/calendars/cal-1");
});

test("deleting a calendar that is already gone is not an error", async () => {
  const { request } = fakeRequest({ "DELETE /calendars/cal-1": () => { throw httpError(404); } });
  await assert.doesNotReject(() => createCalendarClient({ request }).deleteCalendar("cal-1"));
});

test("the client refuses to be built without a way to make requests", () => {
  assert.throws(() => createCalendarClient(), /request function/);
  assert.throws(() => createCalendarClient({ request: "nope" }), /request function/);
});
