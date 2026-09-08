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

# Force the dev server to use the repo browsers (inherited by the background 'node' process)
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.pw-browsers"

echo "==> Theme model tests"
node scripts/theme_test.mjs
THEME_OK=$?
if [ "$THEME_OK" -ne 0 ]; then echo "theme tests FAILED"; exit 1; fi

echo "==> Private view auth model tests"
node --test tests/auth-view.test.js
AUTH_VIEW_OK=$?
if [ "$AUTH_VIEW_OK" -ne 0 ]; then echo "private view auth tests FAILED"; exit 1; fi

echo "==> Refresh-token cookie tests"
node --test tests/token-cookie.test.js
TOKEN_COOKIE_OK=$?
if [ "$TOKEN_COOKIE_OK" -ne 0 ]; then echo "token cookie tests FAILED"; exit 1; fi

echo "==> Enrichment candidate scope tests"
node --test tests/enrich-scope.test.js
ENRICH_SCOPE_OK=$?
if [ "$ENRICH_SCOPE_OK" -ne 0 ]; then echo "enrichment scope tests FAILED"; exit 1; fi

echo "==> Enrichment JSON parsing tests"
node --test tests/enrich-parse.test.js
ENRICH_PARSE_OK=$?
if [ "$ENRICH_PARSE_OK" -ne 0 ]; then echo "enrichment parsing tests FAILED"; exit 1; fi

echo "==> Corpus merge tests"
node --test tests/kb-merge.test.js
KB_MERGE_OK=$?
if [ "$KB_MERGE_OK" -ne 0 ]; then echo "corpus merge tests FAILED"; exit 1; fi

echo "==> Study page model tests (tabs + curriculum)"
node --test tests/study-page.test.js
STUDY_PAGE_OK=$?
if [ "$STUDY_PAGE_OK" -ne 0 ]; then echo "study page model tests FAILED"; exit 1; fi

echo "==> Task kind vocabulary tests"
node --test tests/task-kinds.test.js
TASK_KINDS_OK=$?
if [ "$TASK_KINDS_OK" -ne 0 ]; then echo "task kind vocabulary tests FAILED"; exit 1; fi

echo "==> Redirect sign-in model tests"
node --test tests/auth-redirect.test.js
AUTH_REDIRECT_OK=$?
if [ "$AUTH_REDIRECT_OK" -ne 0 ]; then echo "redirect sign-in tests FAILED"; exit 1; fi

echo "==> Interrupted Classroom build privacy tests"
node --test tests/archive-builder-abort.test.js
ARCHIVE_ABORT_OK=$?
if [ "$ARCHIVE_ABORT_OK" -ne 0 ]; then echo "interrupted Classroom build tests FAILED"; exit 1; fi

echo "==> Resumable Classroom build checkpoint tests"
node --test tests/archive-builder-resume.test.js tests/kb-build-checkpoint.test.js
CHECKPOINT_OK=$?
if [ "$CHECKPOINT_OK" -ne 0 ]; then echo "resumable Classroom checkpoint tests FAILED"; exit 1; fi

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
node scripts/pinned_notes_test.mjs
API_OK=$?
if [ "$API_OK" -ne 0 ]; then echo "API tests FAILED"; exit 1; fi

echo "==> Local retrieval snippet model tests"
node --test tests/kb-client-search.test.js
LOCAL_RETRIEVAL_OK=$?
if [ "$LOCAL_RETRIEVAL_OK" -ne 0 ]; then echo "local retrieval tests FAILED"; exit 1; fi

echo "==> Local download filename/MIME privacy model tests"
node --test tests/kb-download-spec.test.js
download_spec_ok=$?
if [ "$download_spec_ok" -ne 0 ]; then echo "local download filename/MIME tests FAILED"; exit 1; fi

echo "==> Hosted latency model tests"
node --test tests/kb-latency-model.test.js
LATENCY_MODEL_OK=$?
if [ "$LATENCY_MODEL_OK" -ne 0 ]; then echo "latency model tests FAILED"; exit 1; fi

echo "==> Tutor grounding privacy model tests"
node --test tests/kb-tutor-context.test.js
TUTOR_CONTEXT_OK=$?
if [ "$TUTOR_CONTEXT_OK" -ne 0 ]; then echo "tutor grounding privacy tests FAILED"; exit 1; fi

echo "==> KB route-transition privacy model tests"
node --test tests/route-transition-privacy.test.js
ROUTE_TRANSITION_PRIVACY_OK=$?
if [ "$ROUTE_TRANSITION_PRIVACY_OK" -ne 0 ]; then echo "route-transition privacy tests FAILED"; exit 1; fi

echo "==> KB local status accessibility model tests"
node --test tests/kb-local-status.test.js
KB_LOCAL_STATUS_OK=$?
if [ "$KB_LOCAL_STATUS_OK" -ne 0 ]; then echo "KB local status tests FAILED"; exit 1; fi

echo "==> KB local year facet model tests"
node --test tests/kb-local-year-facet.test.js
KB_LOCAL_YEAR_OK=$?
if [ "$KB_LOCAL_YEAR_OK" -ne 0 ]; then echo "KB local year facet tests FAILED"; exit 1; fi

echo "==> KB local browse state model tests"
node --test tests/kb-browse-state.test.js
KB_BROWSE_STATE_OK=$?
if [ "$KB_BROWSE_STATE_OK" -ne 0 ]; then echo "KB browse state tests FAILED"; exit 1; fi

echo "==> Corpus reconciliation tests"
node --test tests/kb-reconcile.test.js
RECONCILE_OK=$?
if [ "$RECONCILE_OK" -ne 0 ]; then echo "reconciliation tests FAILED"; exit 1; fi

echo "==> Auto-sync decision tests"
node --test tests/kb-autosync.test.js
AUTOSYNC_OK=$?
if [ "$AUTOSYNC_OK" -ne 0 ]; then echo "auto-sync tests FAILED"; exit 1; fi

echo "==> Commit-guard secret scanner tests"
python3 scripts/guard_regex_test.py
GUARD_REGEX_OK=$?
if [ "$GUARD_REGEX_OK" -ne 0 ]; then echo "guard secret scanner tests FAILED"; exit 1; fi

echo "==> Live-check mitigation classifier tests"
node --test tests/live-http.test.js
LIVE_HTTP_OK=$?
if [ "$LIVE_HTTP_OK" -ne 0 ]; then echo "live-check classifier tests FAILED"; exit 1; fi

echo "==> Related preview accessibility model tests"
node --test tests/kb-related-status.test.js
KB_RELATED_STATUS_OK=$?
if [ "$KB_RELATED_STATUS_OK" -ne 0 ]; then echo "related preview accessibility tests FAILED"; exit 1; fi

# Starting dev server on :$PORT
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.pw-browsers"
node scripts/dev-server.mjs "$PORT" > /tmp/kb_dev.log 2>&1 &
SRV=$!
# wait for server
for i in $(seq 1 30); do
  curl -s --max-time 2 "http://localhost:$PORT/api/oauth-config" >/dev/null && break
  sleep 0.5
done

echo "==> IndexedDB auth-session reload e2e"
BASE_URL="http://localhost:$PORT" node scripts/auth_session_reload_test.mjs
AUTH_RELOAD_OK=$?
if [ "$AUTH_RELOAD_OK" -ne 0 ]; then echo "auth-session reload e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> IndexedDB auth-session continuity e2e"
BASE_URL="http://localhost:$PORT" node scripts/auth_session_continuity_test.mjs
AUTH_CONTINUITY_OK=$?
if [ "$AUTH_CONTINUITY_OK" -ne 0 ]; then echo "auth-session continuity e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Seeding dev data"
node scripts/seed-dev.mjs "$PORT" 400 >/dev/null 2>&1
echo "==> Theme contrast browser tests"
BASE_URL="http://localhost:$PORT" node scripts/theme_contrast_test.mjs
THEME_CONTRAST_OK=$?
if [ "$THEME_CONTRAST_OK" -ne 0 ]; then echo "theme contrast tests FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Visual common-sense browser gate (light + dark)"
BASE_URL="http://localhost:$PORT" node scripts/visual_common_sense_test.mjs
VISUAL_OK=$?
if [ "$VISUAL_OK" -ne 0 ]; then echo "visual common-sense tests FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> KB copy confirmation mobile e2e"
BASE_URL="http://localhost:$PORT" node scripts/kb_copy_mobile_test.mjs
COPY_MOBILE_OK=$?
if [ "$COPY_MOBILE_OK" -ne 0 ]; then echo "KB copy mobile e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> KB copy history mobile e2e"
BASE_URL="http://localhost:$PORT" node scripts/kb_copy_history_mobile_test.mjs
COPY_HISTORY_MOBILE_OK=$?
if [ "$COPY_HISTORY_MOBILE_OK" -ne 0 ]; then echo "KB copy history mobile e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> KB result-card mobile e2e"
BASE_URL="http://localhost:$PORT" node scripts/kb_result_card_mobile_test.mjs
RESULT_CARD_MOBILE_OK=$?
if [ "$RESULT_CARD_MOBILE_OK" -ne 0 ]; then echo "KB result-card mobile e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Archive migration e2e"
BASE_URL="http://localhost:$PORT" node scripts/study_migration_test.mjs
STUDY_MIGRATION_OK=$?
if [ "$STUDY_MIGRATION_OK" -ne 0 ]; then echo "archive migration e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Study page e2e (tabs, curriculum, manage)"
BASE_URL="http://localhost:$PORT" node scripts/study_tabs_test.mjs
STUDY_TABS_OK=$?
if [ "$STUDY_TABS_OK" -ne 0 ]; then echo "study page e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Mobile layout audit (390/360/320px, light + dark)"
BASE_URL="http://localhost:$PORT" node scripts/mobile_audit_test.mjs
MOBILE_AUDIT_OK=$?
if [ "$MOBILE_AUDIT_OK" -ne 0 ]; then echo "mobile layout audit FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Assignment bottom-sheet e2e"
BASE_URL="http://localhost:$PORT" node scripts/ai_sheet_test.mjs
AI_SHEET_OK=$?
if [ "$AI_SHEET_OK" -ne 0 ]; then echo "assignment sheet e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Mobile navigation overflow e2e"
BASE_URL="http://localhost:$PORT" node scripts/mobile_navigation_overflow_test.mjs
MOBILE_NAV_OK=$?
if [ "$MOBILE_NAV_OK" -ne 0 ]; then echo "mobile navigation overflow e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Browser-local storage hygiene tests"
node --test tests/kb-storage-hygiene.test.js
STORAGE_OK=$?
if [ "$STORAGE_OK" -ne 0 ]; then echo "storage hygiene tests FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Planner card model tests"
node --test tests/planner-cards.test.js
PLANNER_CARDS_OK=$?
if [ "$PLANNER_CARDS_OK" -ne 0 ]; then echo "planner card tests FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Mobile session resume e2e"
BASE_URL="http://localhost:$PORT" node scripts/mobile_session_resume_test.mjs
SESSION_RESUME_OK=$?
if [ "$SESSION_RESUME_OK" -ne 0 ]; then echo "mobile session resume e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Assignment panel open e2e"
BASE_URL="http://localhost:$PORT" node scripts/assignment_panel_open_test.mjs
PANEL_OPEN_OK=$?
if [ "$PANEL_OPEN_OK" -ne 0 ]; then echo "assignment panel open e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Assignment panel close e2e"
BASE_URL="http://localhost:$PORT" node scripts/assignment_panel_close_test.mjs
PANEL_CLOSE_OK=$?
if [ "$PANEL_CLOSE_OK" -ne 0 ]; then echo "assignment panel close e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Background auto-sync e2e"
BASE_URL="http://localhost:$PORT" node scripts/kb_autosync_e2e_test.mjs
AUTOSYNC_E2E_OK=$?
if [ "$AUTOSYNC_E2E_OK" -ne 0 ]; then echo "background auto-sync e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Sidebar overlap e2e"
BASE_URL="http://localhost:$PORT" node scripts/sidebar_overlap_test.mjs
SIDEBAR_OVERLAP_OK=$?
if [ "$SIDEBAR_OVERLAP_OK" -ne 0 ]; then echo "sidebar overlap e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Sticky header e2e"
BASE_URL="http://localhost:$PORT" node scripts/sticky_header_test.mjs
STICKY_OK=$?
if [ "$STICKY_OK" -ne 0 ]; then echo "sticky header e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Inline build progress layout e2e"
BASE_URL="http://localhost:$PORT" node scripts/inline_build_progress_test.mjs
INLINE_BUILD_OK=$?
if [ "$INLINE_BUILD_OK" -ne 0 ]; then echo "inline build progress e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> KB reduced-motion loading e2e"
BASE_URL="http://localhost:$PORT" node scripts/kb_reduced_motion_test.mjs
REDUCED_MOTION_OK=$?
if [ "$REDUCED_MOTION_OK" -ne 0 ]; then echo "KB reduced-motion e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Cross-view reduced-motion related-error e2e"
BASE_URL="http://localhost:$PORT" node scripts/cross_view_reduced_motion_error_test.mjs
CROSS_VIEW_REDUCED_MOTION_OK=$?
if [ "$CROSS_VIEW_REDUCED_MOTION_OK" -ne 0 ]; then echo "cross-view reduced-motion e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Cross-view mobile retry focus-ring e2e"
BASE_URL="http://localhost:$PORT" node scripts/cross_view_retry_focus_test.mjs
CROSS_VIEW_RETRY_FOCUS_OK=$?
if [ "$CROSS_VIEW_RETRY_FOCUS_OK" -ne 0 ]; then echo "cross-view mobile retry focus-ring e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> KB narrow related-preview status e2e"
BASE_URL="http://localhost:$PORT" node scripts/kb_related_mobile_status_test.mjs
KB_RELATED_MOBILE_STATUS_OK=$?
if [ "$KB_RELATED_MOBILE_STATUS_OK" -ne 0 ]; then echo "KB narrow related-preview status e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> KB result-card focus-ring e2e"
BASE_URL="http://localhost:$PORT" node scripts/kb_result_card_focus_test.mjs
RESULT_CARD_FOCUS_OK=$?
if [ "$RESULT_CARD_FOCUS_OK" -ne 0 ]; then echo "KB result-card focus-ring e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

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

echo "==> Settings clear/rebuild e2e (local)"
BASE_URL="http://localhost:$PORT" node scripts/settings_clear_rebuild_test.mjs
SETTINGS_CLEAR_OK=$?
if [ "$SETTINGS_CLEAR_OK" -ne 0 ]; then echo "settings clear/rebuild e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Settings mobile clear/rebuild e2e (local)"
BASE_URL="http://localhost:$PORT" node scripts/settings_mobile_rebuild_test.mjs
SETTINGS_MOBILE_REBUILD_OK=$?
if [ "$SETTINGS_MOBILE_REBUILD_OK" -ne 0 ]; then echo "settings mobile clear/rebuild e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> KB rebuild-to-Planner mobile e2e (local)"
BASE_URL="http://localhost:$PORT" node scripts/kb_rebuild_to_planner_mobile_test.mjs
KB_REBUILD_PLANNER_MOBILE_OK=$?
if [ "$KB_REBUILD_PLANNER_MOBILE_OK" -ne 0 ]; then echo "KB rebuild-to-Planner mobile e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> KB cross-view modal focus visibility e2e"
BASE_URL="http://localhost:$PORT" node scripts/kb_cross_view_focus_test.mjs
KB_CROSS_VIEW_FOCUS_OK=$?
if [ "$KB_CROSS_VIEW_FOCUS_OK" -ne 0 ]; then echo "KB cross-view modal focus e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Route-transition focus hint mobile theme e2e"
BASE_URL="http://localhost:$PORT" node scripts/route_transition_hint_mobile_test.mjs
ROUTE_HINT_MOBILE_OK=$?
if [ "$ROUTE_HINT_MOBILE_OK" -ne 0 ]; then echo "route-transition hint mobile e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Resumed Classroom checkpoint privacy and surface e2e"
BASE_URL="http://localhost:$PORT" node scripts/kb_checkpoint_browser_test.mjs
CHECKPOINT_BROWSER_OK=$?
if [ "$CHECKPOINT_BROWSER_OK" -ne 0 ]; then echo "resumed Classroom checkpoint browser e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Cross-view continuity smoke (local)"
BASE_URL="http://localhost:$PORT" node scripts/continuity_smoke_test.mjs
CONTINUITY_OK=$?
if [ "$CONTINUITY_OK" -ne 0 ]; then echo "continuity smoke FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Production cache diagnostics isolation smoke (local integrated + harness)"
BASE_URL="http://localhost:$PORT" node scripts/cache_diagnostics_isolation_test.mjs
CACHE_ISOLATION_OK=$?
if [ "$CACHE_ISOLATION_OK" -ne 0 ]; then echo "cache diagnostics isolation smoke FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Warm local KB note round-trip e2e"
BASE_URL="http://localhost:$PORT" node scripts/kb_note_roundtrip_test.mjs
KB_NOTE_ROUNDTRIP_OK=$?
if [ "$KB_NOTE_ROUNDTRIP_OK" -ne 0 ]; then echo "warm local KB note round-trip e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

echo "==> Planner tutor mobile grounding e2e"
BASE_URL="http://localhost:$PORT" node scripts/planner_tutor_mobile_test.mjs
PLANNER_MOBILE_OK=$?
if [ "$PLANNER_MOBILE_OK" -ne 0 ]; then echo "planner tutor mobile e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

kill "$SRV" 2>/dev/null

if [ "$UI_OK" -ne 0 ]; then echo "UI e2e FAILED"; exit 1; fi

# Exit 75 (EX_TEMPFAIL) from a live script means "inconclusive": Vercel edge
# mitigation challenged this runner, so the app was never actually observed.
# That is an infrastructure condition, NOT a production regression — treat it
# as a warning so the autonomous loop does not raise a false blocker.
# See scripts/live-http.mjs for the classification rules.
INCONCLUSIVE=75

echo "==> Live-site e2e (default production; set KB_SKIP_LIVE=1 to skip)"
if [ "${KB_SKIP_LIVE:-}" = "1" ] || [ "${KB_SKIP_LIVE:-}" = "true" ] || [ "${KB_LIVE_URL:-}" = "skip" ]; then
  echo "[live] KB_SKIP_LIVE — skipping live verification."
  LIVE_OK=0
else
  # Default matches kb_live_test.mjs / seed-vault so cron never silently skips.
  export KB_LIVE_URL="${KB_LIVE_URL:-https://classroom-knowledge.vercel.app}"
  echo "[live] KB_LIVE_URL=$KB_LIVE_URL"
  node scripts/kb_live_test.mjs
  LIVE_OK=$?
  if [ "$LIVE_OK" -eq "$INCONCLUSIVE" ]; then
    # Skip the follow-on live smokes: they target the same edge that just
    # refused us, so they would only produce more phantom failures.
    LIVE_SETTINGS_CLEAR_OK=0
    LIVE_CROSS_VIEW_OK=0
  elif [ "$LIVE_OK" -eq 0 ]; then
    echo "==> Live Settings clear/rebuild smoke"
    BASE_URL="$KB_LIVE_URL" node scripts/settings_clear_rebuild_test.mjs
    LIVE_SETTINGS_CLEAR_OK=$?
    echo "==> Live cross-view related-retry smoke"
    node scripts/live_cross_view_related_retry_test.mjs
    LIVE_CROSS_VIEW_OK=$?
  else
    LIVE_SETTINGS_CLEAR_OK=1
    LIVE_CROSS_VIEW_OK=1
  fi
fi

if [ "$LIVE_OK" -eq "$INCONCLUSIVE" ]; then
  echo ""
  echo "WARNING: live checks INCONCLUSIVE — Vercel edge mitigation blocked the runner."
  echo "         Production is NOT known to be broken. Do not open a blocker for this."
  echo "         Confirm by hand from a normal network:"
  echo "           curl -sI $KB_LIVE_URL/ | head -1"
  echo "         Local + pre-deploy gates above all passed."
  echo "ALL TESTS PASSED (live verification inconclusive)"
  exit 0
fi

# Name what actually failed. "LIVE E2E FAILED (production regression detected)"
# used to be printed for ALL three, including the two follow-on smokes — which
# sent someone hunting a production fault when the site was healthy and a smoke
# had simply gone stale against a deliberate app change.
if [ "$LIVE_OK" -ne 0 ]; then
  echo "LIVE E2E FAILED: scripts/kb_live_test.mjs (exit $LIVE_OK) — production regression"
  exit 1
fi
if [ "${LIVE_SETTINGS_CLEAR_OK:-0}" -ne 0 ]; then
  echo "LIVE SMOKE FAILED: scripts/settings_clear_rebuild_test.mjs (exit $LIVE_SETTINGS_CLEAR_OK)"
  echo "  kb_live_test.mjs passed, so production is serving. Check the smoke before the app."
  exit 1
fi
if [ "${LIVE_CROSS_VIEW_OK:-0}" -ne 0 ]; then
  echo "LIVE SMOKE FAILED: scripts/live_cross_view_related_retry_test.mjs (exit $LIVE_CROSS_VIEW_OK)"
  echo "  kb_live_test.mjs passed, so production is serving. Check the smoke before the app."
  exit 1
fi

echo "ALL TESTS PASSED"
