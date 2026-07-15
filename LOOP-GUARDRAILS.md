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
1. `node --check` on every changed `.js` / `.mjs`.
2. `node scripts/kb_e2e_test.mjs` returns exit 0 (retrieval + filter sanity).
3. **Visual check**: run the dev server (`scripts/dev-server.mjs`), open the
   KB tab in the browser, perform a search, and capture a screenshot. The
   screenshot must show results + filter chips (no blank/error state). If the
   screenshot shows an error, abort.
4. The change addresses exactly one ROADMAP.md item.

## 4. Reporting
- Every iteration posts to `#kb-site-status` (via `scripts/post_status.py`):
  what changed, test result, and the screenshot path/link.
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
