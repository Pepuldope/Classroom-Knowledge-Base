# Long-Term AI Upgrade Loop — Guardrails

These rules govern the autonomous loop that improves the Classroom Knowledge
Base site. The loop (cron `long-term-site-dev` + manual iterations) MUST obey
them. If a change violates any rule, it is aborted and rolled back.

## 1. Never self-destruct the site
- **No deletion of core files.** `index.html`, `app.js`, `styles.css`,
  `api/oauth-config.js`, `api/_helpers.js`, `api/kb-store.js`, `scripts/post_status.py`
  are PROTECTED. The loop may edit `kb.js`, `api/kb-*.js`, `api/tutor.js`,
  `api/ai-router.js`, `ROADMAP.md`, `README.md` — but must not delete or
  rewrite them wholesale.
- **No schema changes to the shared KB bundle** without a migration + human note.
  The bundle shape `{version:1, notes:[...]}` is a contract with live users'
  data. Changing `note` fields requires back-compat.
- **No force-push / `--force` / `--no-verify`** to `master`. Ever.
- **No `git reset --hard` to a remote state** that discards local commits.

## 2. No risky mutations
- **Never commit secrets.** Scan every diff for `sk-`, `nvapi-`, `gsk_`,
  `csk-`, `AKIA`, `ghp_`, `github_pat_`, `AIza`, private key blobs, `--depth`,
  `.env`. If found, abort and report.
- **Never touch OAuth client secret** or rotate credentials.
- **Never modify `api/oauth-config.js`** (Google client id lives there) without
  explicit human instruction.
- **Never run destructive SQL / KV `flushall`** or delete the production
  knowledge base.
- **Never change deploy/infra config** (vercel.json, env vars, DNS) without a
  pinned @mention to Pepuldo first.

## 3. Quality gates (all must pass BEFORE a commit)
These layers together answer **“is the feature working?”** — not just “did one test file exit 0.”
1. `node --check` on every changed `.js` / `.mjs` (syntax).
2. `node scripts/kb_e2e_test.mjs` returns exit 0 (retrieval + filter / logic sanity).
   Run the rest of `bash scripts/test.sh` / focused unit + interaction e2e as
   appropriate for the change (UI flows, loading, settings, continuity, live).
3. **Visual common-sense check (standing UI layer of “feature works”)** — run the
   dev server (`scripts/dev-server.mjs`), exercise the changed surface end-to-end
   in the browser, capture a smoke screenshot (results + chips / expected UI;
   abort on blank/error). **Screenshots alone are NOT enough.** Every UI-affecting
   commit must also run the **common-sense visual gate** (light AND dark at minimum):
   - **Contrast:** computed fg/bg luminance on representative text; fail normal
     text below 4.5:1 (large/UI text below 3:1).
   - **Control states:** primary/secondary/nav/chips/icon/Settings controls must
     show distinct styling for default, `:hover`, `:active` (pressed),
     `:focus-visible`, and `:disabled` where those states exist (visible
     bg/border/color change; real focus ring; disabled de-emphasized).
   - **Layout hygiene:** text must not spill past its box; no horizontal page
     overflow; no clipped labels/controls; no zero-size clickable text targets;
     no obvious overlapping interactive hits.
   Use this gate to confirm the feature is usable in general (readable, clickable
   states look right, nothing broken/clipped) — same stack as code/e2e, not a
   separate pretty-pass. Never report “visual OK” / “screenshot verified” from a
   light-theme-only PNG or geometry-only gates (border-radius / centering /
   non-transparent bg).
4. The change addresses exactly one ROADMAP.md item.

## 4. Reporting
- Every iteration posts to `#kb-site-status` (via `scripts/post_status.py`):
  what changed, test result, and the screenshot path/link.
- At the start of every iteration run `python3 scripts/post_status.py --retain-only`
  so the channel stays a rolling 7-day view while full history is archived to
  `/opt/data/logs/channel-history/kb-site-status/` (not a separate cron).
- If the loop is BLOCKED (needs Vercel URL, KV keys, OAuth domain, or a human
  decision), it posts with `--mention` + `--pin` so Pepuldo is pinged and can
  find it pinned.
- If a provider is exhausted, the router fails over silently — no need to ping.

## 5. Rollback
- Keep each feature in its own commit. On a failed gate, `git revert` that
  commit (no force). Never leave `master` in a broken state.
- If the dev server crashes or the site returns 500 on the KB route, the loop
  stops and @mentions Pepuldo — it does NOT keep retrying blindly.

## 7. Authentication MUST NOT lock the user into the wrong account
- The site stores a Classroom refresh token server-side (KV key `refresh:<sub>`).
  A silent auto-login from that token is fine ONLY IF the user can always escape it.
- **Hard invariant — never regress these:**
  1. Every interactive sign-in path (`loginBtn`, `switchBtn`, token/code client) must
     pass `prompt: "select_account"` so the Google account chooser is shown. The loop
     must NEVER remove `select_account` or add a silent `prompt: "consent"`-only path
     that reuses the last account.
  2. The `Switch account` menu action and `Sign out` must both call the server
     `/api/oauth-revoke` endpoint so the stored refresh token is deleted — otherwise
     the wrong account silently re-logs in on the next page load.
  3. `handleWrongAccount()` must remain: if Classroom returns 400/403 (the signed-in
     account isn't a Classroom account), clear the token, revoke the server token, and
     return to the welcome screen with a clear message — never loop on the error.
- **Why this is non-negotiable:** in 2026-07 a cron run strengthened silent re-login
  (focus area "persistent sign-in") and the user got trapped on their personal Google
  account with a 400 and no way to switch. The `scripts/guard.py` backstop (rule #6
  there) mechanically blocks any commit that removes `select_account`, `oauth-revoke`,
  or `handleWrongAccount`. If the loop wants persistent sign-in, it must implement it
  WITHOUT breaking these three escape hatches — e.g. persist the token AND keep the
  chooser + revoke + wrong-account recovery intact.

## 6. AI model usage
- The tutor and any agent task use `api/ai-router.js`, which fans out across
  every available provider (OpenRouter, local FreeLLMAPI proxy, Groq, Cerebras,
  Mistral, NVIDIA, GitHub Models, Qwen, Google Gemini) and fails over on
  429/5xx/auth errors. Use as many as are configured — don't pin to one.

## 7. Live checks: infrastructure failures are not blockers
- **A failing live check does not by itself mean production is broken.** Two very
  different things produce the same red result: (a) the app regressed, (b) Vercel's
  edge mitigation challenged *the test runner* and we never observed the app at all.
- **Case (b) is documented, recurring, and NOT caused by deploying.** Run logs from
  2026-07-26 through 2026-08-01 repeatedly show HTTP 403 with
  `x-vercel-mitigated: challenge` against the production alias — Vercel's managed bot
  protection reacting to the runner's datacenter IP. In the 2026-08-01 incident **no
  `vercel deploy` ran between the passing pre-deploy check and the failing post-deploy
  one**, so "passed before deploy, 403 after" is coincidence, not causation. It cannot
  be turned off from the Vercel side: an IP-keyed Firewall bypass rule was tried on
  2026-08-01 and does not work — Vercel's IP matcher never matches this runner. Proven
  with a Deny probe: a path-only rule fired (403), the same rule plus an IP condition
  did not (404), in plain and CIDR form. **Do not re-attempt the IP-bypass approach.**
  Classifying the challenge as inconclusive is the permanent mitigation, not a stopgap.
- **Mechanism:** `scripts/live-http.mjs` classifies responses. `scripts/kb_live_test.mjs`
  warms the edge, retries with backoff (5s/20s/60s), and exits **75** (`EX_TEMPFAIL`)
  for "inconclusive" instead of 1. `scripts/test.sh` maps 75 to a warning and exits 0.
- **Hard invariant — the loop must NOT:**
  1. Open a blocker, or park backlog items, on an inconclusive (exit 75) live result.
  2. Redeploy, roll back, or "fix" application code in response to one. Nothing is known
     to be wrong. Changing code here means changing a working site based on no evidence.
  3. Widen `isEdgeMitigation()` to swallow plain 403s with no mitigation evidence — the
     app's own JSON 403s must keep failing loudly. `tests/live-http.test.js` guards this.
- **Before escalating a live failure, confirm it independently** from outside the runner:
  `curl -sI https://classroom-knowledge-google.vercel.app/ | head -1`. If that is 200,
  the site is up and there is no blocker — say so plainly and continue with the backlog.
- **Why this is here:** on 2026-08-01 a cron run reported a hard blocker — "Vercel edge
  HTTP 403 on /index.html and /api/kb-search, 1/4 live checks passing" — and stopped
  autonomous work. Production was serving 200 the whole time, and the deployed build
  hashed identical to HEAD. The "1/4" was the tell: check 1 (site loads) 403'd, checks
  2–3 cascaded, and check 4 ("no uncaught page errors") passed *vacuously* because no
  page had loaded. That vacuous pass is now asserted against.
