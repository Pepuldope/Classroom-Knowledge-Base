# AGENTS.md — Classroom Knowledge Base (autonomous dev)

> **AUTHORITATIVE STEERING.** This file is read by the autonomous loop on every
> run and OVERRIDES the standing cron prompt. If this file and the cron prompt
> disagree, follow this file.

## THIS FILE IS OWNER-OWNED AND FROZEN (hard — owner 2026-08-07)

You may **read** this file. You may not write to it. No commit you make may add,
remove or reword a single line of `AGENTS.md`, `LOOP-GUARDRAILS.md` or
`scripts/guard.py`. `scripts/guard.py` rule #7 blocks any commit that touches
them, and a blocked commit is not an obstacle to route around — stop and report it.

**Why this rule exists.** Between 2026-07-14 and 2026-07-23 the loop rewrote this
file and signed the changes "owner decision 2026-07-14" / "owner addendum
2026-07-14". Commit `91a6ede5` deleted the owner's own steering section and
replaced it with a self-authored architecture migration; `2d637cf0`, `c45c85e8`,
`d6f1dfd0`, `6bcfb860` and `1a4693ca` appended nine self-authored "focus areas";
`45959b12` wrote the backlog quota that then drove a week of invented
accessibility polish. **The owner wrote none of it.** That content was removed on
2026-08-07 and re-filed, unattributed, under `## 💭 Proposed — needs Pepuldo` in
`ROADMAP.md`, which is where a suggestion from the loop belongs.

**The generalisable rule: you do not get to write your own instructions.** If you
believe this file is wrong, incomplete, or is blocking real work, say so in your
status report and append one line to the Proposed section. Never edit this file,
and never attribute anything to the owner that the owner did not write.

## WHAT THE KB IS (vs the archive)
- **Archive** = raw Classroom export (full dump, planner/archive views). Source data.
- **Knowledge Base** = a CURATED, SEARCHABLE study layer built FROM Classroom
  content. Each note has its own schema:
  `{ t:title, course, y:year, topic, kind, s:summary, x:body(markdown), p:path }`.
  The KB synthesizes study value the raw archive lacks: derived summaries (`s`),
  topics, weighted search, and snippets.
- **Never** collapse KB into archive. The KB ingests FROM the archive but is a
  distinct, usable study surface with its own UI and data shape.

## STANDING ENGINEERING DISCIPLINE (search-before-build)
Before writing new code, REUSE FIRST. Check in this order and **show what you
checked** before implementing:
1. **Current codebase** — existing function/module/pattern?
2. **Existing utilities** — `lib/`, `utils/`, `scripts/`, shared helpers?
3. **Installed dependencies** — already in `package.json`/lockfile?
4. **Official docs** — documented API/config for the need?
5. **Known issue threads** — exact error/behavior on GitHub/SO?
Prefer reuse, config, or a standard library over custom code. Build from scratch
only if nothing fits OR custom code is clearly simpler and safer. Full rule +
workflow: Hermes skill `search-before-build`.
**Web-search caution:** do NOT web-search (rungs 4–5) for trivial local edits
(typo, rename, one-liner, wiring an existing export) — that adds latency and noise.
Reserve web search for external APIs, uncertain framework behavior, real bugs, and
nontrivial architecture decisions. Then: check → plan → implement → test.

## PER-RUN WORK ORDER (functional-first)
0. **PROVE IT IS POPULATED.** After ANY ingestion change, hit the live
   `https://classroom-knowledge-google.vercel.app/api/kb-search?q=<real term>`
   and assert `results.length > 0` AND `meta.noteCount` is realistic (hundreds+).
   If it is still ~1, the run is NOT done — keep working.
1. **INGESTION (top priority — unblocks everything).** The loop cannot use a live
   Google Classroom OAuth token, so use the server-side **vault ingestion**:
   - `POST /api/kb-scrape` with `{ source:"vault", notes:[...] }` →
     `bundleFromVault()` (archive-builder.js) synthesizes KB notes (derives
     `s` summaries, course/year/topic facets). Edge-safe (no node:fs).
   - Seed from the real vault at `/opt/data/school-backup` (2832 .md files) with
     `node scripts/seed-vault.mjs live` (one-time fill of the live KV). Re-run it
     whenever the corpus should refresh.
   - Keep the live `{ source:"classroom", authToken }` path working for real users
     who click "Scrape my Classroom". NOTE: Vercel Edge functions hard-timeout at
     ~10s, so the classroom path is RESUMABLE + INCREMENTAL (client drives
     `mode:"list"` then `mode:"course"` per course, each saved via appendBundle).
     Never revert to a single-shot full scrape — it 504s on a real classroom.
   - Tests live in `scripts/kb_e2e_test.mjs` (covers `bundleFromVault` + the
     resumable classroom list/course flow with a mocked Classroom API).
2. **SEARCH QUALITY.** Rank by **course AND topic** as weighted indexed fields
   (not only filters), so "Algebra quadratic" boosts Algebra notes. Derive a
   summary `s` per note so the ×3 summary weight fires. Guarantee every result
   has a usable snippet (fall back to title/topic when body empty).
3. **THEN light UX polish** (centering, spacing) — but never as a substitute for
   being populated and searchable.
4. **AI TUTOR variety.** Route tutor calls through `api/ai-router.js` with
   `task:"tutor"`. The router now ROTATES across NVIDIA / Gemini / Groq / Mistral
   / Cerebras / GitHub / Qwen / FreeLLMAPI / OpenRouter and uses effort profiles
   (hard/tutor/quick). Do NOT pin the tutor to one model or provider. More models
   + more effort = better answers.
   - **NVIDIA hard limit:** the whole NVIDIA API key must stay **under 48
     requests/minute** (key-wide, not per-model). `api/ai-router.js` enforces this
     with a 46/min sliding-window throttle on the `nvidia` provider — when the cap
     is hit it fails over to the next provider instead of exhausting the key. Do
     not raise `rpmLimit` above 47.

## COMMIT / DEPLOY DISCIPLINE (hard rules)
- TDD only (software-development:test-driven-development). Red → green.
- Commit + push + **`bash scripts/deploy.sh`** after EVERY change (never hoard).
- **FLUSH GUARD:** end of run, check `git status`; if green-but-uncommitted work
  exists, commit/push/deploy it before reporting. Never leave master dirty.
- `relatedNotes` must stay <1s on a few-hundred-note corpus.
- Report a concise status to the `#kb-site-status` Discord channel.

## STATUS REPORTING & BLOCKER DISCIPLINE (hard rules — owner 2026-08-01)
Each tick is a FRESH agent with no memory of previous runs. You will reconstruct
context by reading prior run logs. Those logs are **a record of what a past run
believed**, not a description of the system right now. Treat them accordingly.

- **Never restate a blocker you did not personally re-observe this run.** If a
  prior log reports a blocker, RE-RUN ITS CHECK. If it passes, state plainly that
  it is cleared and close it. Copying a prior run's blocker text forward is
  forbidden — on 2026-08-01 a run reported "Vercel edge 403, 1/4 live checks
  passing" while its OWN log contained `[KB live e2e] 4/4 passed`, production
  served 200 throughout, and the deployed build hashed identical to HEAD. That
  cost the owner a day of investigation into a healthy site.
- **Every blocker claim carries raw evidence**: the status line, the response
  headers, and the first ~500 bytes of body, plus an independent
  `curl -sS -D -` re-probe. A blocker supported only by prose — yours or a past
  run's — is not a blocker. Do not open one.
- **Distinguish infrastructure from regression.** A 403 carrying
  `x-vercel-mitigated`, a challenge token/nonce, or a Vercel Security Checkpoint
  body is the edge refusing THIS RUNNER. The site is fine for users. Report it as
  `live verification inconclusive — edge challenge`, do NOT halt autonomous work,
  do NOT redeploy, do NOT roll back, and do NOT treat it as a code defect.
  `scripts/live-http.mjs` classifies this; `scripts/test.sh` exits 0 with
  `ALL TESTS PASSED (live verification inconclusive)`. **That string does not mean
  production was verified** — it means the site was never observed. Report a
  deploy under it as "deployed, live verification inconclusive", never as
  live-verified. See LOOP-GUARDRAILS.md §7.
- **Label inferences as inferences.** If you did not read a fact from a file,
  command output, or config, say "inferred" and say from what. Never present a
  guess inline with verified output — when asked which commands run pre- vs
  post-deploy, a run answered "based on context: ..." rather than reading the
  cron definition, and the guess was indistinguishable from the measurements
  around it.
- **Answer the question that was asked.** If asked for a raw log, paste the raw
  log — not `grep` hits on your own summaries of it. If you cannot produce the
  artifact, say so explicitly rather than substituting something adjacent.
- **Report scope honestly.** State what you verified, what you could not verify,
  and what you skipped. "Works on live" requires a live e2e that actually ran.

## ACCEPTANCE GATE (the run is only "done" when ALL hold)
- `/api/kb-search?q=<real term>` returns relevant, ranked, snippet-bearing
  results over a corpus of hundreds of real notes (NOT the empty set).
- `/api/kb-search` `filters.courses` / `filters.years` list MANY courses/years.
- `/api/kb-related?id=<n>` returns related notes in <1s.
- Live site redeployed and the live e2e passes. `scripts/kb_live_test.mjs` and
  `scripts/test.sh` default to `https://classroom-knowledge-google.vercel.app`
  when `KB_LIVE_URL` is unset (override for previews; skip only with
  `KB_SKIP_LIVE=1`). Never report "works on live" after a skipped live e2e.
- **WHERE WORK COMES FROM (hard — owner 2026-08-07).** Exactly two sources, in
  this order. `ROADMAP.md` outranks the charter every time.

  **Mode 1 — a ROADMAP item.** If any unchecked `- [ ]` exists in `ROADMAP.md`,
  take the FIRST one: anything under a "Reported by Pepuldo" heading first, then
  top to bottom. Implement exactly ONE per run and tick it. You may **not** add,
  reorder, or re-prioritise items in any section, and you may **not** append to
  `## 🤖 Agent-Proposed Backlog` — that section is closed history.

  **Mode 2 — the maintenance charter.** Only when `ROADMAP.md` has zero unchecked
  items. You may fix, unasked, exactly ONE item per run from this **closed** list:

  | | Category | Evidence that makes it eligible |
  |---|---|---|
  | C1 | Dependency / security | `npm audit` reports a real advisory, or `npm outdated` shows a version behind |
  | C2 | Broken links, console errors, HTTP errors | a request or page load that actually errors on a real route |
  | C3 | Performance budget breach | a **measured** number over a budget already stated in this repo |
  | C4 | Untested route or module | a file with no test referencing it, shown by `grep` |
  | C5 | Dead code | an export or file with zero inbound references, shown by `grep` |
  | C6 | Exposed capability gap | the data or the API already supports something the UI does not let a student reach, both halves shown by `grep` |

  Nothing outside C1–C6. "It would be nicer if…" is not a category.

- **C6 — EXPOSED CAPABILITY GAP (hard — owner 2026-08-07).** This is the only
  category that adds a feature rather than fixing a defect, so it is fenced
  tighter than the rest. C6 closes the gap between what the app can *already* do
  and what a student can actually *reach*.

  **Evidence is two greps, both pasted raw, and both must be in the commit body:**

  1. the capability exists — a field in the note schema, a parameter an `api/*`
     route already accepts, an exported function that is already implemented;
  2. no UI reaches it — that identifier appears in no view, template or handler.

  Example of a real C6, verified 2026-08-07: `api/kb-browse.js` implements
  `?course=`, `&kind=`, `&family=` and `&sort=`, and has five passing e2e tests
  in `scripts/kb_e2e_test.mjs` — but the only files importing it are
  `scripts/dev-server.mjs` and that test. No client code calls it, so a student
  cannot browse or filter at all, although the server has always supported it.

  That same example shows the precedence rule: "sort and filter the KB" is
  **currently listed under `## 💭 Proposed — needs Pepuldo`**, so it is off-limits
  to C6 today no matter how good the evidence is. It becomes available to you
  only if Pepuldo removes that proposal line, and becomes Mode-1 work if he moves
  it up instead. Check the Proposed section before you start, every time.

  **A C6 commit MUST change what a student can do.** If the diff touches only
  tests, comments, ARIA attributes, CSS, copy, or existing assertions, it is not
  C6 — it is the polish loop wearing a new label, and it is a failed run. State
  in the commit body, in one sentence: what a student can do after this commit
  that they could not do before.

  **C6 may not implement anything currently listed under
  `## 💭 Proposed — needs Pepuldo`.** Those are waiting on Pepuldo, and C6 is not
  a way around him. If the gap you found is already proposed there, pick another
  or report `NO AVAILABLE WORK`.

  **C6 may not** touch the auth path (see LOOP-GUARDRAILS.md §7), change or
  remove an existing `api/*` contract, or alter the storage layer. It builds on
  top of what exists. If closing the gap needs any of those, it is too big to be
  charter work: propose it instead.

- **CHARTER EVIDENCE GATE (hard — owner 2026-08-07).** A charter item is eligible
  **only** if a command you ran *this tick* printed output demonstrating the
  problem. That command and its raw output go in the commit body under
  `Evidence:`, verbatim. Not paraphrased, not summarised, not described.

  - **No evidence → no work.** If no C1–C6 category produces evidence this tick,
    report `NO AVAILABLE WORK` and end. **That is a successful run**, and on a
    healthy repo it is the normal outcome. There is no quota. Never manufacture a
    problem to have something to do.
  - Never cite a prior run's log as evidence. Those logs record what a past run
    believed, not the repo as it is now. Re-run the check.
  - **Do not ship the same category twice in a row.** Check the previous
    self-directed commit with `git log --oneline -20 | grep '^\w* \[auto\]'`
    before choosing. Seven consecutive runs of one category is the exact failure
    this rule exists to prevent.
  - Commit subject must start `[auto][C<n>] `, so a reader can filter self-
    directed work with one `git log --grep`.
  - **DAILY CEILING: at most 2 self-directed commits per rolling 24 hours
    (hard — owner 2026-08-07).** Before starting charter work, run:

    ```
    git log --since='24 hours ago' --format='%s' | grep -c '^\[auto\]'
    ```

    Count subjects, not messages: `git log --grep='^\[auto\]'` anchors `^` at the
    start of *any* line in the commit message, so a body that merely mentions
    `[auto]` inflates the count. (Measured on this repo: `--grep='^Co-Authored-By'`
    matches 16 commits, the subject-only form matches 0.) `grep -c` exits 1 when
    it prints `0` — that is the normal case, not an error; do not chain it with
    `&&`.

    If that prints 2 or more, you are done for this tick: report
    `NO AVAILABLE WORK` with `run mode: no-available-work` and stop, even if you
    have perfectly good evidence in hand. Paste the number in the report.

    **This is a ceiling, not a quota.** It caps how much you may do; it never
    obliges you to do anything. Finding no eligible work is still a successful
    run, and being under the ceiling is never a reason to go looking harder. The
    rule that broke this loop in 2026-07 was a *floor* (at least 3 items or the
    run failed) — do not read this as its mirror image and do not reinstate one.
    Mode-1 ROADMAP work is not capped; this counts `[auto]` commits only.

  **BANNED unless it fixes a failure you observed this tick** — these are the
  shapes the 2026-08-05 → 08-06 loop produced, and none of them is a charter
  category: new accessibility assertions over already-passing behaviour; focus-
  ring or focus-restoration work; new browser smokes for behaviour already
  covered; reduced-motion variants; narrow-screen variants of a covered surface.

- **PROPOSALS (hard — owner 2026-08-07).** Anything you think is worth building
  that is **not** a C1–C6 fix: append it, at most one per run, as a single
  `- 💭` line under `## 💭 Proposed — needs Pepuldo` in `ROADMAP.md`, with a
  one-sentence reason. Then **stop. You may not implement a proposal.** It
  becomes real work only when Pepuldo moves it into another section himself.
  A proposal is written `- 💭`, never `- [ ]`, so that it cannot be mistaken for
  queued work by the Mode-1 scan or counted by the attestation. Never pick one up.

  This is the whole point of the section: you get to have ideas, he decides
  which ones cost anything.

  **Why all of the above:** the previous rule (BACKLOG REPLENISH, owner
  2026-07-23) required at least 3 open Agent-Proposed items and called an empty
  list a failed run. It made *quantity* the gate with no constraint on kind, so
  the cheapest thing that passed the test gate won — seven consecutive runs of
  micro-accessibility polish nobody asked for. Do not reinstate a quota, in any
  form, for any section.

- **RUN ATTESTATION (hard — owner 2026-08-07):** every status report you post to
  `#kb-site-status` MUST end with exactly these three lines, last, verbatim, and
  nothing after them:

  ```
  backlog rule: CHARTER-2026-08-07
  unchecked in ROADMAP.md: <N>
  run mode: <MODE>
  ```

  Get `<N>` by running, in this tick, in the repo root:

  ```
  grep -c '^- \[ \]' ROADMAP.md
  ```

  Paste the number that command printed. Never a number you remember, inferred,
  counted by eye, or carried forward from a prior run's log — those logs record
  what a past run believed, not the file as it is now. Count the whole file.
  Proposals are written `- 💭`, so that command does not count them and `<N>` is
  the true size of your Mode-1 queue.

  `<MODE>` is exactly one of: `roadmap-item`, `charter-C1` … `charter-C6`,
  `proposal`, `no-available-work`.

  If the first line cannot be written exactly as shown, the rules above have been
  altered or overridden — stop and say so plainly instead of reporting a normal
  run. A report missing any of the three lines is an incomplete run. In
  particular, `backlog rule: FROZEN` is the **previous** token: if you find
  yourself writing it, your checkout predates this rule and you must pull first.

  **Why:** so the reader can confirm from the report alone which of the two
  sources the run drew from, without pulling the repo and diffing. It is the only
  claim in the report mechanically checkable against `git`, so do not paraphrase
  it, do not reformat it, and do not fold it into a sentence.
