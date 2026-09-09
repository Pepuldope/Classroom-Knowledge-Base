// calendar-api.js — the Google Calendar calls, with the network injected.
//
// `request` is passed in rather than calling fetch directly, so every branch
// that matters — a calendar the student deleted, an event that already exists,
// a page of results, a revoked grant — is exercised in the fast `models` group
// instead of only ever being discovered in production by a person.
//
// `request(method, path, body?)` resolves to parsed JSON (or null for 204) and
// rejects with an Error carrying `.status` for any non-2xx.

import { newCalendarBody, calendarVisibilityPatch } from "./calendar-consent.js";
import { APP_MARKER } from "./calendar-event.js";

/** Events we created carry this, so nothing else on the calendar is ever seen. */
export const MANAGED_QUERY = `app=${APP_MARKER}`;

const enc = encodeURIComponent;

export function createCalendarClient({ request, timeZone = "" } = {}) {
  if (typeof request !== "function") throw new TypeError("createCalendarClient needs a request function");

  /**
   * The calendar id to write to, creating the calendar if there isn't one.
   *
   * Two ways to have no calendar: never made one, or the student deleted it in
   * Google. The second is the one that matters — without the 404 check every
   * subsequent write fails forever and the feature looks broken with no way
   * back. `onCreate` lets the caller persist the new id.
   */
  async function ensureCalendar(calendarId, { onCreate } = {}) {
    if (calendarId) {
      try {
        await request("GET", `/calendars/${enc(calendarId)}`);
        return calendarId;
      } catch (error) {
        // 404 (deleted) or 410 (gone) — make a new one. Anything else is a
        // real failure and must not silently spawn duplicate calendars.
        if (error?.status !== 404 && error?.status !== 410) throw error;
      }
    }
    const created = await request("POST", "/calendars", newCalendarBody({ timeZone }));
    const id = created?.id;
    if (!id) throw new Error("Calendar created but Google returned no id");
    await onCreate?.(id);
    return id;
  }

  /**
   * Every event we created on that calendar, following pagination.
   *
   * Filtered server-side by our private extended property, so a student's own
   * events on the same calendar are never even fetched, let alone reconciled.
   */
  async function listManagedEvents(calendarId) {
    const events = [];
    let pageToken = "";
    // A guard rather than `while (true)`: a server that keeps handing back the
    // same token would otherwise spin forever on someone's phone.
    for (let page = 0; page < 40; page++) {
      const query = new URLSearchParams({
        privateExtendedProperty: MANAGED_QUERY,
        maxResults: "250",
        showDeleted: "false",
        singleEvents: "true",
      });
      if (pageToken) query.set("pageToken", pageToken);
      const body = await request("GET", `/calendars/${enc(calendarId)}/events?${query}`);
      for (const item of body?.items || []) events.push(item);
      pageToken = body?.nextPageToken || "";
      if (!pageToken) break;
    }
    return events;
  }

  /**
   * Apply one operation.
   *
   * `create` tolerates 409: the event already exists, which happens whenever
   * two devices sync at once or a previous run wrote it and failed to record
   * that. Because ids are deterministic, the right answer is to patch it, not
   * to make a second one.
   *
   * `delete` tolerates 404/410: something we were going to remove is already
   * gone, which is success by any reading.
   */
  async function applyOp(calendarId, op) {
    const base = `/calendars/${enc(calendarId)}/events`;
    if (op.op === "create") {
      try {
        await request("POST", base, op.body);
        return { ...op, result: "created" };
      } catch (error) {
        if (error?.status !== 409) throw error;
        await request("PATCH", `${base}/${enc(op.id)}`, op.body);
        return { ...op, result: "patched", note: "already existed" };
      }
    }
    if (op.op === "patch") {
      await request("PATCH", `${base}/${enc(op.id)}`, op.body);
      return { ...op, result: "patched" };
    }
    if (op.op === "delete") {
      try {
        await request("DELETE", `${base}/${enc(op.id)}`);
        return { ...op, result: "deleted" };
      } catch (error) {
        if (error?.status !== 404 && error?.status !== 410) throw error;
        return { ...op, result: "deleted", note: "already gone" };
      }
    }
    return { ...op, result: "skipped" };
  }

  /**
   * Apply a whole plan, in order, one at a time.
   *
   * Sequential on purpose. This runs on a phone while somebody is reading, the
   * plan is normally a handful of operations, and Calendar's per-user rate
   * limit punishes bursts far more than it rewards them.
   *
   * One failed operation does not abandon the rest: a single malformed event
   * should not stop nineteen good ones. The failures come back for the caller
   * to report.
   */
  async function applyPlan(calendarId, ops, { onProgress } = {}) {
    const done = [];
    const failed = [];
    for (const op of ops) {
      if (op.op === "skip") { done.push({ ...op, result: "skipped" }); continue; }
      try {
        done.push(await applyOp(calendarId, op));
      } catch (error) {
        failed.push({ ...op, error: `${error?.status || ""} ${error?.message || error}`.trim() });
      }
      onProgress?.(done.length + failed.length, ops.length);
    }
    return { done, failed };
  }

  /** Hide or unhide the calendar. This is the on/off switch; it never deletes. */
  async function setVisibility(calendarId, visible) {
    await request("PATCH", `/users/me/calendarList/${enc(calendarId)}`, calendarVisibilityPatch(visible));
  }

  /** Delete the calendar outright — only ever from the explicit button. */
  async function deleteCalendar(calendarId) {
    try {
      await request("DELETE", `/calendars/${enc(calendarId)}`);
    } catch (error) {
      if (error?.status !== 404 && error?.status !== 410) throw error;
    }
  }

  return { ensureCalendar, listManagedEvents, applyPlan, applyOp, setVisibility, deleteCalendar };
}

/** A `request` backed by fetch, for the real app. */
export function googleCalendarRequest(getToken, { fetchImpl = fetch } = {}) {
  const BASE = "https://www.googleapis.com/calendar/v3";
  return async (method, path, body) => {
    const response = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(`Calendar API ${response.status}: ${text.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json().catch(() => null);
  };
}
