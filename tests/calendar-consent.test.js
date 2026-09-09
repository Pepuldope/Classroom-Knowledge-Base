// Asking for Calendar access, and remembering the answer per account.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CALENDAR_SCOPE, calendarAuthRequest, hasCalendarScope, calendarStateModel,
  calendarStateFor, setCalendarStateFor, calendarStatusModel,
  newCalendarBody, calendarVisibilityPatch, CALENDAR_SUMMARY,
} from "../calendar-consent.js";

test("only the least-privilege scope is ever requested", () => {
  const request = calendarAuthRequest({ loginHint: "student@example.edu" });
  assert.equal(request.scope, "https://www.googleapis.com/auth/calendar.app.created");
  // The two that would give us the student's whole calendar.
  assert.ok(!request.scope.includes("auth/calendar.events"));
  assert.equal(request.scope.split(/\s+/).length, 1, "one scope, not a bundle");
  assert.equal(request.loginHint, "student@example.edu");
});

test("the incremental request does not make you pick an account again", () => {
  // select_account mid-settings reads as a bug: you are already signed in.
  assert.ok(!calendarAuthRequest().prompt.includes("select_account"));
  assert.equal(calendarAuthRequest().prompt, "consent");
  assert.equal(calendarAuthRequest().loginHint, "");
});

test("a grant is only a grant if Calendar is actually in it", () => {
  // A student can untick a permission on the consent screen. Treating the
  // redirect coming back as success is how the switch shows on and every
  // write 403s.
  assert.equal(hasCalendarScope(`openid ${CALENDAR_SCOPE}`), true);
  assert.equal(hasCalendarScope([CALENDAR_SCOPE, "openid"]), true);
  assert.equal(hasCalendarScope("openid https://www.googleapis.com/auth/classroom.courses.readonly"), false);
  assert.equal(hasCalendarScope(""), false);
  assert.equal(hasCalendarScope(null), false);
  assert.equal(hasCalendarScope(undefined), false);
  // Not a prefix match: a longer scope that merely starts the same is not it.
  assert.equal(hasCalendarScope(`${CALENDAR_SCOPE}.readonly`), false);
});

test("state is keyed per Google account", () => {
  // Switching accounts with one global calendar id points the sync at a
  // calendar owned by somebody else: every write 404s and the recovery path
  // makes a duplicate in the wrong account.
  let state = setCalendarStateFor(null, "sub-a", { enabled: true, calendarId: "cal-a" });
  state = setCalendarStateFor(state, "sub-b", { enabled: false, calendarId: "cal-b" });

  assert.equal(calendarStateFor(state, "sub-a").calendarId, "cal-a");
  assert.equal(calendarStateFor(state, "sub-b").calendarId, "cal-b");
  assert.equal(calendarStateFor(state, "sub-a").enabled, true);
  assert.equal(calendarStateFor(state, "sub-b").enabled, false);
});

test("an account never seen before is off with no calendar", () => {
  assert.deepEqual(calendarStateFor(null, "nobody"), { enabled: false, calendarId: "", lastSyncAt: "" });
  assert.deepEqual(calendarStateFor({}, ""), { enabled: false, calendarId: "", lastSyncAt: "" });
});

test("patching one account leaves the others untouched", () => {
  let state = setCalendarStateFor(null, "sub-a", { enabled: true, calendarId: "cal-a", lastSyncAt: "2026-09-09T10:00:00.000Z" });
  state = setCalendarStateFor(state, "sub-a", { lastSyncAt: "2026-09-09T12:00:00.000Z" });
  assert.equal(calendarStateFor(state, "sub-a").calendarId, "cal-a", "a partial patch does not wipe the id");
  assert.equal(calendarStateFor(state, "sub-a").enabled, true);
  assert.equal(calendarStateFor(state, "sub-a").lastSyncAt, "2026-09-09T12:00:00.000Z");
});

test("garbage in storage normalizes rather than throwing", () => {
  assert.deepEqual(calendarStateModel(), { version: 1, accounts: {} });
  assert.deepEqual(calendarStateModel("nope"), { version: 1, accounts: {} });
  assert.deepEqual(calendarStateModel({ accounts: [] }), { version: 1, accounts: {} });
  assert.deepEqual(calendarStateModel({ accounts: { "": { enabled: true } } }).accounts, {});
  assert.deepEqual(
    calendarStateModel({ accounts: { a: { enabled: "yes", calendarId: 42, lastSyncAt: {} } } }).accounts.a,
    { enabled: false, calendarId: "", lastSyncAt: "" },
    "wrong types become defaults, never leak through",
  );
  assert.equal(setCalendarStateFor(null, "", { enabled: true }).accounts[""], undefined);
});

test("the Settings row distinguishes on from working", () => {
  assert.equal(calendarStatusModel().state, "off");
  assert.match(calendarStatusModel().label, /not being written/);

  // Switched on, but Google did not grant it (or it was revoked later).
  const revoked = calendarStatusModel({ enabled: true, granted: false });
  assert.equal(revoked.state, "needs-consent");
  assert.equal(revoked.action, "reconnect", "the student has to be told, not left with a switch that lies");

  assert.equal(calendarStatusModel({ enabled: true, granted: true }).state, "pending");
  assert.equal(calendarStatusModel({ enabled: true, granted: true, calendarId: "c" }).state, "ready");
});

test("a synced calendar says how long ago, in words", () => {
  const now = Date.parse("2026-09-09T12:00:00.000Z");
  const at = (iso) => calendarStatusModel({ enabled: true, granted: true, calendarId: "c", lastSyncAt: iso, now }).label;
  assert.match(at("2026-09-09T11:59:30.000Z"), /just now/);
  assert.match(at("2026-09-09T11:20:00.000Z"), /40m ago/);
  assert.match(at("2026-09-09T06:00:00.000Z"), /6h ago/);
  assert.match(at("2026-09-06T12:00:00.000Z"), /3d ago/);
  assert.match(at("nonsense"), /Waiting for the first sync/);
});

test("the calendar we create names itself and is safe to delete", () => {
  const body = newCalendarBody({ timeZone: "Europe/Bratislava" });
  assert.equal(body.summary, CALENDAR_SUMMARY);
  assert.equal(body.timeZone, "Europe/Bratislava");
  assert.match(body.description, /Safe to hide or delete/);
  assert.equal(newCalendarBody().timeZone, undefined, "no timezone means Google picks the account default");
});

test("the switch hides and unhides — it never deletes", () => {
  assert.deepEqual(calendarVisibilityPatch(false), { hidden: true, selected: false });
  assert.deepEqual(calendarVisibilityPatch(true), { hidden: false, selected: true });
});
