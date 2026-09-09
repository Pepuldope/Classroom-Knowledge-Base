# Google Calendar integration — design

Owner request (2026-09-09): *"You get an assignment and it shows up in your
Google Calendar."*

Status: **plan only, nothing built.** Written to be executed one phase per
session, or one ROADMAP item per loop tick.

---

## 1. The constraint that shapes everything

This is a static site. There is no server that knows a student exists between
page loads. So "you get an assignment and it shows up" splits into two very
different products:

| | What it means | What it costs |
|---|---|---|
| **Sync on open** | The calendar is correct within seconds of you opening the site | Nothing new. The app already syncs the corpus on open (`kb-autosync.js`) |
| **True background** | The event appears while the tab is closed | A server that stores refresh tokens and runs on a cron — see Phase 4 |

Phases 1–3 deliver sync-on-open, which for a student who opens the planner most
days is indistinguishable from magic. Phase 4 is the real thing and carries a
real cost. **Do not start with Phase 4.**

### The privacy question, answered up front

The app's pitch is "your notes stay in this browser". Writing assignments to
Google Calendar looks like it breaks that promise. It does not, and the reason
matters: **the assignments already come FROM Google.** Copying a Classroom
assignment into Google Calendar discloses nothing to Google it did not give us.
What would break the promise is sending anything to *our* server — which is
exactly what Phase 4 does, and why it is fenced off.

---

## 2. Scope: use `calendar.app.created`, not `calendar.events`

The single most important decision here.

```
https://www.googleapis.com/auth/calendar.app.created
  "Make secondary Google calendars, and see, create, change, and delete
   events on them"
```

The app creates its own calendar and can touch **only** that calendar. It cannot
read, edit, or delete anything in the student's real calendar — not their
lessons, not their private events, nothing. Compare `calendar.events`, which is
"view and modify all calendar events" on every calendar they have.

This is better on every axis: the consent screen is honest, a bug in our sync
cannot damage anything the student cares about, and the blast radius of a stolen
token is one calendar we made.

Consequence: the design is **a dedicated "Classroom" calendar**, not events
scattered into the primary one. That is also better UX — one toggle in Google
Calendar hides all of it.

### Incremental auth: do NOT add this to sign-in

Today `SCOPES` in `app.js:34` is six Classroom scopes, granted at sign-in, and
the welcome card says *"Tick all the boxes ✅ — we need all of them"*. Adding
Calendar there would force every user to grant calendar access in order to use
the planner, and would re-prompt every existing user.

Instead: a separate consent, triggered by an explicit opt-in, using
`include_granted_scopes=true` so the Classroom grant is preserved. Somebody who
never turns it on never sees a calendar prompt.

**Also update** the privacy list in Settings → Study (`index.html`,
`#kbPrivacySummary`) to state what is written and where. If the copy does not
change, the feature should not ship.

---

## 3. Event identity: deterministic ids, no mapping table

Google accepts a client-supplied event id. The rules (verified against the
Events.insert reference, 2026-09-09):

- character set is **base32hex**: lowercase `a`–`v` and `0`–`9`
- **5 to 1024** characters
- unique per calendar

So derive it: `sha256(courseId + ":" + courseWorkId)` → first 20 bytes →
base32hex → lowercase → prefix `ck`.

This is worth more than it looks. With a deterministic id:

- upsert needs no local mapping table, so there is nothing to migrate, corrupt,
  or lose when the browser is cleared;
- the same assignment produces the same event **on every device**, so two
  browsers syncing the same account converge instead of duplicating;
- a resync after clearing local data repairs the calendar instead of doubling it.

Upsert is `events.insert`; on `409 Conflict` fall back to `events.patch`.

---

## 4. Phase 1 — the one-way mirror

**Goal:** every pending assignment with a due date exists as an event.

New pure module `calendar-event.js`:

```js
calendarEventId(courseId, courseWorkId)   // -> deterministic base32hex id
calendarEventBody(assignment, { timeZone, calendarLink })
calendarSyncPlan(assignments, existingEvents)  // -> [{op, id, body}]
```

Everything above is pure and unit-tested in the `models` group. The network and
DOM layer stays thin, because this session established that logic living inside
DOM functions is the main reason work here is expensive.

### Event shape

| Field | Value |
|---|---|
| `summary` | assignment title |
| `description` | enrichment `oneLineSummary`, then the Classroom link |
| `source.url` | `alternateLink` |
| `colorId` | stable per course, so subjects are visually distinct |
| `extendedProperties.private` | `{ courseWorkId, courseId, fingerprint }` |
| `reminders` | popup at 1 day and 2 hours |

### The two bugs this will have if nobody says this now

1. **All-day `end.date` is exclusive.** An assignment due Friday needs
   `start.date = Friday`, `end.date = Saturday`. Get this wrong and every
   deadline shows a day early or spans two days.
2. **Classroom `dueDate`/`dueTime` is UTC.** Convert to the student's timezone
   or work lands at 01:00. `dueDate` with no `dueTime` → all-day; with a
   `dueTime` → a timed 30-minute block ending at the deadline.

### When it runs

Reuse `kbAutoSyncModel` in `kb-autosync.js` rather than inventing a second
cadence. It already answers "is this stale enough to refresh, are we online, are
we signed in, are we backing off after a failure". Calendar sync is one more
consumer of that decision.

---

## 5. Phase 2 — keeping it true

A mirror that only ever adds is worse than no mirror.

- **Submitted → delete the event.** A calendar full of finished work is noise.
  (Alternative: prefix `✓` and strip reminders. Pepuldo's call — recommend
  delete.)
- **Coursework deleted or unpublished → delete the event.**
- **Due date or title changed → patch.**
- **Full reconcile:** list events on our calendar carrying our
  `privateExtendedProperty`, and delete any whose `courseWorkId` is no longer in
  the corpus. The repo already has this shape in `kb-reconcile.test.js` — follow
  it rather than inventing a second reconciliation model.

### Never clobber a student's edit

If someone moves a study block, that is the most valuable data in the system.
Store a `fingerprint` of what we last wrote in the event's extended properties.
On sync, if the live event's own fields differ from that fingerprint, a human
changed it: patch nothing, log it, leave it alone. Only fields we still own get
updated.

### Recover from a deleted calendar

If the student deletes the calendar, every write starts returning 404. Detect
it, drop the stored calendar id, recreate on the next sync. Do not let one 404
wedge the feature permanently.

---

## 6. Phase 3 — work blocks, not just deadlines

This is where the feature stops being a mirror and becomes worth having.

The enrichment already produces `estimatedMinutes` for every assignment. A
deadline in a calendar is a reminder you will ignore; a *scheduled two-hour
block on Thursday evening* is a plan. The data for this already exists and no
UI reaches it — which is exactly the shape of a real capability gap.

- Needs `calendar.freebusy` to find gaps. Read-only availability, no event
  content.
- **Propose, never impose.** Show suggested blocks, student confirms. Silently
  filling somebody's evenings is how an app gets uninstalled.
- Respect the deadline: blocks go before the due date, never after.

---

## 7. Phase 4 — true background sync (decide before building)

The only phase that delivers "it shows up" with the tab closed. It needs a
server-side job holding a refresh token per opted-in student, plus a Vercel Cron
that runs a Classroom delta and a Calendar upsert.

The refresh-token infrastructure partly exists (`api/token-cookie.test.js`, the
`hasRefreshTokens` flag in `/api/oauth-config`).

**This is a decision, not a task.** It means the site starts holding long-lived
Google credentials for real people on a shared server — the exact thing the
privacy copy currently promises it does not do, and the exact shape of the
credential that leaked in this ecosystem before (see the `gho_` token incident
in the root CLAUDE.md). If it ships:

- encrypt refresh tokens at rest, never log them, never return them to a client;
- one clearly-worded opt-in, separate from the Calendar opt-in;
- a visible "disconnect" that revokes server-side;
- rewrite the privacy summary honestly.

Recommendation: **ship Phases 1–3, live with them for a few weeks, and only then
decide whether the tab-closed case is worth this.** For a student who opens the
planner daily, it may simply not be.

---

## 8. Risks

| Risk | Handling |
|---|---|
| `calendar.app.created` is a sensitive scope → Google verification needed above 100 users | Fine at personal scale; the unverified-app screen is tolerable. Flag before any wider release |
| API quota on a large corpus | Sync deltas only, never the whole corpus; the fingerprint makes a no-op sync free |
| Wrong timezone / off-by-one dates | Pure functions with tests covering DST, all-day exclusivity and a missing `dueTime` — before any network code |
| Duplicate events across devices | Solved by deterministic ids (§3), not by a mapping table |
| Feature silently stops working | Surface last-sync state in the same stat bar the corpus uses |

---

## 9. Suggested ROADMAP items

Small enough for one loop tick each:

1. `calendar-event.js` + tests: deterministic id, event body, all-day exclusivity, timezone conversion. No network.
2. `calendarSyncPlan()` + tests: corpus × existing events → create/patch/delete/skip.
3. Incremental-auth opt-in in Settings → Study, plus the privacy copy. No syncing yet.
4. Create the secondary calendar on first opt-in; store its id; recreate on 404.
5. Wire the plan to the API, on `kbAutoSyncModel`'s cadence. Phase 1 done.
6. Phase 2: submitted/deleted handling, fingerprint guard, full reconcile.
7. Phase 3: `freebusy` + proposed work blocks.

Add a `calendar` group to `scripts/test.sh` as soon as item 1 lands.
