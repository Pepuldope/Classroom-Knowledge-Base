#!/usr/bin/env bash
# test.sh — combined test gate for the Classroom Knowledge Base.
# Runs the fast API tests + the real-browser UI e2e (local), then the live-site
# e2e against production (or KB_LIVE_URL). Skip live with KB_SKIP_LIVE=1.
# Used by the autonomous loop's verification step and by `scripts/guard.py`.
#
# Usage: bash scripts/test.sh [port]
#   port  defaults to 4321 (the dev-server port)
set -u
PORT="${1:-4321}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Playwright browsers live in the repo's .pw-browsers (the default system
# cache at /opt/hermes is root-owned and not writable by the agent).
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$ROOT/.pw-browsers}"

echo "==> Theme model tests"
node scripts/theme_test.mjs
THEME_OK=$?
if [ "$THEME_OK" -ne 0 ]; then echo "theme tests FAILED"; exit 1; fi

echo "==> Study streak model tests"
node scripts/study_streak_test.mjs
STREAK_OK=$?
if [ "$STREAK_OK" -ne 0 ]; then echo "study streak tests FAILED"; exit 1; fi

echo "==> Study progress model tests"
node scripts/study_progress_test.mjs
PROGRESS_OK=$?
if [ "$PROGRESS_OK" -ne 0 ]; then echo "study progress tests FAILED"; exit 1; fi

echo "==> Weekly review digest model tests"
node scripts/review_digest_test.mjs
REVIEW_DIGEST_OK=$?
if [ "$REVIEW_DIGEST_OK" -ne 0 ]; then echo "review digest tests FAILED"; exit 1; fi

echo "==> Tutor attribution model tests"
node scripts/tutor_provider_test.mjs
TUTOR_ATTRIBUTION_OK=$?
if [ "$TUTOR_ATTRIBUTION_OK" -ne 0 ]; then echo "tutor attribution tests FAILED"; exit 1; fi

echo "==> Tutor retry model tests"
node scripts/tutor_retry_test.mjs
TUTOR_RETRY_OK=$?
if [ "$TUTOR_RETRY_OK" -ne 0 ]; then echo "tutor retry tests FAILED"; exit 1; fi

echo "==> API / retrieval tests"
node scripts/kb_e2e_test.mjs
API_OK=$?
if [ "$API_OK" -ne 0 ]; then echo "API tests FAILED"; exit 1; fi

echo "==> Starting dev server on :$PORT"
node scripts/dev-server.mjs "$PORT" > /tmp/kb_dev.log 2>&1 &
SRV=$!
# wait for server
for i in $(seq 1 30); do
  curl -s --max-time 2 "http://localhost:$PORT/api/oauth-config" >/dev/null && break
  sleep 0.5
done

echo "==> Seeding dev data"
node scripts/seed-dev.mjs "$PORT" 400 >/dev/null 2>&1

echo "==> Browser UI e2e (local)"
BASE_URL="http://localhost:$PORT" node scripts/kb_ui_test.mjs
UI_OK=$?

echo "==> KB loading-state e2e (local)"
BASE_URL="http://localhost:$PORT" node scripts/kb_loading_test.mjs
LOAD_OK=$?
if [ "$LOAD_OK" -ne 0 ]; then echo "loading e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Settings styling e2e (local)"
BASE_URL="http://localhost:$PORT" node scripts/settings_ui_test.mjs
SETTINGS_OK=$?
if [ "$SETTINGS_OK" -ne 0 ]; then echo "settings styling e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Cross-view continuity smoke (local)"
BASE_URL="http://localhost:$PORT" node scripts/continuity_smoke_test.mjs
CONTINUITY_OK=$?
if [ "$CONTINUITY_OK" -ne 0 ]; then echo "continuity smoke FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

kill "$SRV" 2>/dev/null

if [ "$UI_OK" -ne 0 ]; then echo "UI e2e FAILED"; exit 1; fi

echo "==> Live-site e2e (default production; set KB_SKIP_LIVE=1 to skip)"
if [ "${KB_SKIP_LIVE:-}" = "1" ] || [ "${KB_SKIP_LIVE:-}" = "true" ] || [ "${KB_LIVE_URL:-}" = "skip" ]; then
  echo "[live] KB_SKIP_LIVE — skipping live verification."
  LIVE_OK=0
else
  # Default matches kb_live_test.mjs / seed-vault so cron never silently skips.
  export KB_LIVE_URL="${KB_LIVE_URL:-https://classroom-knowledge-google.vercel.app}"
  echo "[live] KB_LIVE_URL=$KB_LIVE_URL"
  node scripts/kb_live_test.mjs
  LIVE_OK=$?
fi

if [ "$LIVE_OK" -ne 0 ]; then
  echo "LIVE E2E FAILED (production regression detected)"
  exit 1
fi

echo "ALL TESTS PASSED"
