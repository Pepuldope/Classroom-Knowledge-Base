#!/usr/bin/env bash
# test.sh — the gate, as a table.
#
# WHY IT LOOKS LIKE THIS
#   This was 300 lines of copy-pasted `node X; X_OK=$?; if [ $X_OK -ne 0 ] ...`,
#   one block per gate, in one linear all-or-nothing run of ~80 gates and
#   several minutes. There was no way to say "just the panel ones", so every
#   iteration on a two-line CSS change either ran everything or ran nothing —
#   which is most of why working in this repo was expensive.
#
#   The gates are a table now. Each row declares which groups it belongs to and
#   what it needs to run, and the runner works out the rest: start the dev
#   server only if some selected gate needs it, seed dev data only if some
#   selected gate needs that, and stop on the first failure.
#
# USAGE
#   bash scripts/test.sh                      # everything (what CI/cron runs)
#   bash scripts/test.sh --group models       # pure node tests, no browser, ~5s
#   bash scripts/test.sh --group panel,mobile # iterate on what you changed
#   bash scripts/test.sh --list               # groups, and what is in them
#   bash scripts/test.sh --group kb 4321      # a port still goes last
#
#   KB_SKIP_LIVE=1   skip the live-site gates
#   KB_LIVE_URL=...  point the live gates elsewhere (default: production)
#
# ADDING A GATE
#   Add one row to GATES. Do not add another if-block; there aren't any left.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Playwright browsers live in the repo's .pw-browsers (the default system cache
# at /opt/hermes is root-owned and not writable by the agent). Exported so the
# background dev-server process inherits it too.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$ROOT/.pw-browsers}"

# ---------------------------------------------------------------------------
# The table.
#
#   groups | needs | label | command
#
# `needs` is one of:
#   -       nothing; pure node, runs anywhere
#   net     reaches the public internet (not the app) — skipped when offline
#   srv     needs the dev server, and must run BEFORE dev data is seeded
#   seed    needs the dev server WITH dev data
#
# A gate may list several groups. `models` is deliberately everything that runs
# without a browser: it is the loop you want while writing logic.
# ---------------------------------------------------------------------------
GATES=(
"models|-|Theme model tests|node scripts/theme_test.mjs"
"models|-|Private view auth model tests|node --test tests/auth-view.test.js"
"models|-|Refresh-token cookie tests|node --test tests/token-cookie.test.js"
"models|-|Enrichment candidate scope tests|node --test tests/enrich-scope.test.js"
"models|-|Enrichment JSON parsing tests|node --test tests/enrich-parse.test.js"
"models|-|Corpus merge tests|node --test tests/kb-merge.test.js"
"models|-|Study page model tests (tabs + curriculum)|node --test tests/study-page.test.js"
"models|-|Task kind vocabulary tests|node --test tests/task-kinds.test.js"
"models|-|Redirect sign-in model tests|node --test tests/auth-redirect.test.js"
"models|-|Cross-device prefs merge model tests|node --test tests/prefs-sync.test.js"
"models|-|Interrupted Classroom build privacy tests|node --test tests/archive-builder-abort.test.js"
"models|-|Resumable Classroom build checkpoint tests|node --test tests/archive-builder-resume.test.js tests/kb-build-checkpoint.test.js"
"models,panel|-|Assignment panel model tests|node --test tests/assignment-panel.test.js"
"models,api|-|Enrichment model chain fall-through tests|node --test tests/enrich-chain.test.js"
"models,mobile|-|Session position + sheet drag model tests|node --test tests/session-position.test.js tests/sheet-drag.test.js"
"models,mobile|-|Pull-to-refresh + report freshness model tests|node --test tests/pull-refresh.test.js"
"mobile,panel|seed|Sheet scroll containment + pull-to-dismiss|node scripts/sheet_scroll_test.mjs"
"mobile|seed|Standalone pull-to-refresh|node scripts/pull_refresh_test.mjs"
"models|-|Study streak model tests|node scripts/study_streak_test.mjs"
"models|-|Study progress model tests|node scripts/study_progress_test.mjs"
"models|-|Weekly review digest model tests|node scripts/review_digest_test.mjs"
"models|-|Tutor attribution model tests|node scripts/tutor_provider_test.mjs"
"models|-|Tutor retry model tests|node scripts/tutor_retry_test.mjs"
"models,api|-|API / retrieval tests|node scripts/kb_e2e_test.mjs"
"models,api|-|Pinned notes tests|node scripts/pinned_notes_test.mjs"
"models,kb|-|Local retrieval snippet model tests|node --test tests/kb-client-search.test.js"
"models,kb|-|Local download filename/MIME privacy model tests|node --test tests/kb-download-spec.test.js"
"models,kb|-|Hosted latency model tests|node --test tests/kb-latency-model.test.js"
"models,kb|-|Tutor grounding privacy model tests|node --test tests/kb-tutor-context.test.js"
"models,kb|-|KB route-transition privacy model tests|node --test tests/route-transition-privacy.test.js"
"models,kb|-|KB local status accessibility model tests|node --test tests/kb-local-status.test.js"
"models,kb|-|KB local year facet model tests|node --test tests/kb-local-year-facet.test.js"
"models,kb|-|KB local browse state model tests|node --test tests/kb-browse-state.test.js"
"models,kb|-|Search relevance benchmark|node --test tests/kb-search-relevance.test.js"
"models,kb|-|Corpus reconciliation tests|node --test tests/kb-reconcile.test.js"
"models,kb|-|Auto-sync decision tests|node --test tests/kb-autosync.test.js"
"models,kb|-|Browser-local storage hygiene tests|node --test tests/kb-storage-hygiene.test.js"
"models|-|Planner card model tests|node --test tests/planner-cards.test.js"
"models|-|Commit-guard secret scanner tests|python3 scripts/guard_regex_test.py"
"models|-|Live-check mitigation classifier tests|node --test tests/live-http.test.js"
"models,kb|-|Related preview accessibility model tests|node --test tests/kb-related-status.test.js"
"models|net|Every OpenRouter model id is live and free|node scripts/model_catalogue_test.mjs"
"auth|srv|IndexedDB auth-session reload e2e|node scripts/auth_session_reload_test.mjs"
"auth|srv|IndexedDB auth-session continuity e2e|node scripts/auth_session_continuity_test.mjs"
"auth|srv|Returning user never sees the sign-in card|node scripts/auth_restore_flash_test.mjs"
"auth|srv|Cross-device prefs convergence e2e|node scripts/prefs_sync_convergence_test.mjs"
"theme|seed|Theme contrast browser tests|node scripts/theme_contrast_test.mjs"
"theme|seed|Visual common-sense browser gate (light + dark)|node scripts/visual_common_sense_test.mjs"
"kb,mobile|seed|KB copy confirmation mobile e2e|node scripts/kb_copy_mobile_test.mjs"
"kb,mobile|seed|KB copy history mobile e2e|node scripts/kb_copy_history_mobile_test.mjs"
"kb,mobile|seed|KB result-card mobile e2e|node scripts/kb_result_card_mobile_test.mjs"
"kb|seed|Archive migration e2e|node scripts/study_migration_test.mjs"
"kb|seed|Study page e2e (tabs, curriculum, manage)|node scripts/study_tabs_test.mjs"
"mobile|seed|Mobile layout audit (390/360/320px, light + dark)|node scripts/mobile_audit_test.mjs"
"mobile|seed|Mobile place/sheet e2e (reload position, filters, stat bar, drag handle)|node scripts/mobile_place_test.mjs"
"panel|seed|Assignment panel layout budget (desktop + phone)|node scripts/panel_audit.mjs"
"panel|seed|Assignment bottom-sheet e2e|node scripts/ai_sheet_test.mjs"
"panel|seed|Assignment panel open e2e|node scripts/assignment_panel_open_test.mjs"
"panel|seed|Assignment panel close e2e|node scripts/assignment_panel_close_test.mjs"
"panel,mobile|seed|Planner tutor mobile grounding e2e|node scripts/planner_tutor_mobile_test.mjs"
"mobile,layout|seed|Mobile navigation overflow e2e|node scripts/mobile_navigation_overflow_test.mjs"
"mobile|seed|Mobile session resume e2e|node scripts/mobile_session_resume_test.mjs"
"kb|seed|Background auto-sync e2e|node scripts/kb_autosync_e2e_test.mjs"
"layout|seed|Sidebar overlap e2e|node scripts/sidebar_overlap_test.mjs"
"layout|seed|Sticky header e2e|node scripts/sticky_header_test.mjs"
"layout|seed|Inline build progress layout e2e|node scripts/inline_build_progress_test.mjs"
"kb|seed|KB reduced-motion loading e2e|node scripts/kb_reduced_motion_test.mjs"
"kb|seed|Cross-view reduced-motion related-error e2e|node scripts/cross_view_reduced_motion_error_test.mjs"
"kb,mobile|seed|Cross-view mobile retry focus-ring e2e|node scripts/cross_view_retry_focus_test.mjs"
"kb,mobile|seed|KB narrow related-preview status e2e|node scripts/kb_related_mobile_status_test.mjs"
"kb|seed|KB result-card focus-ring e2e|node scripts/kb_result_card_focus_test.mjs"
"kb|seed|Browser UI e2e (local)|node scripts/kb_ui_test.mjs"
"kb|seed|KB loading-state e2e (local)|node scripts/kb_loading_test.mjs"
"settings|seed|Settings styling e2e (local)|node scripts/settings_ui_test.mjs"
"settings|seed|Settings clear/rebuild e2e (local)|node scripts/settings_clear_rebuild_test.mjs"
"settings,mobile|seed|Settings mobile clear/rebuild e2e (local)|node scripts/settings_mobile_rebuild_test.mjs"
"kb,mobile|seed|KB rebuild-to-Planner mobile e2e (local)|node scripts/kb_rebuild_to_planner_mobile_test.mjs"
"kb|seed|KB cross-view modal focus visibility e2e|node scripts/kb_cross_view_focus_test.mjs"
"kb,mobile|seed|Route-transition focus hint mobile theme e2e|node scripts/route_transition_hint_mobile_test.mjs"
"kb|seed|Resumed Classroom checkpoint privacy and surface e2e|node scripts/kb_checkpoint_browser_test.mjs"
"kb|seed|Cross-view continuity smoke (local)|node scripts/continuity_smoke_test.mjs"
"kb|seed|Production cache diagnostics isolation smoke|node scripts/cache_diagnostics_isolation_test.mjs"
"kb|seed|Warm local KB note round-trip e2e|node scripts/kb_note_roundtrip_test.mjs"
)

ALL_GROUPS="models api auth theme kb panel mobile settings layout live"

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
SELECT=""
PORT=""
LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --group|-g) SELECT="${2:-}"; shift 2 ;;
    --group=*)  SELECT="${1#--group=}"; shift ;;
    --list|-l)  LIST=1; shift ;;
    --help|-h)  sed -n '2,30p' "$0"; exit 0 ;;
    *)          PORT="$1"; shift ;;
  esac
done
PORT="${PORT:-4321}"

if [ "$LIST" -eq 1 ]; then
  echo "groups (gate counts):"
  for g in $ALL_GROUPS; do
    n=0
    for row in "${GATES[@]}"; do
      case ",${row%%|*}," in *",$g,"*) n=$((n + 1)) ;; esac
    done
    [ "$g" = "live" ] && n=3
    printf "  %-9s %2d\n" "$g" "$n"
  done
  echo
  echo "usage: bash scripts/test.sh --group models,panel"
  exit 0
fi

selected() { # selected <comma-separated groups of the row>
  [ -z "$SELECT" ] && return 0
  local row_groups="$1" want
  local IFS=,
  for want in $SELECT; do
    case ",$row_groups," in *",$want,"*) return 0 ;; esac
  done
  return 1
}

# Validate the requested groups rather than silently running nothing.
if [ -n "$SELECT" ]; then
  IFS=, read -r -a WANTED <<< "$SELECT"
  for want in "${WANTED[@]}"; do
    case " $ALL_GROUPS " in
      *" $want "*) ;;
      *) echo "unknown group '$want'. Known: $ALL_GROUPS"; exit 2 ;;
    esac
  done
fi

# ---------------------------------------------------------------------------
# The dev server and its data, started only if something selected needs them.
# ---------------------------------------------------------------------------
SRV=""
SEEDED=0
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null; return 0; }
trap cleanup EXIT INT TERM

start_server() {
  [ -n "$SRV" ] && return 0
  echo "--- starting dev server on :$PORT"
  node scripts/dev-server.mjs "$PORT" > /tmp/kb_dev.log 2>&1 &
  SRV=$!
  for _ in $(seq 1 30); do
    curl -s --max-time 2 "http://localhost:$PORT/api/oauth-config" >/dev/null && return 0
    sleep 0.5
  done
  echo "dev server did not come up on :$PORT — see /tmp/kb_dev.log"
  exit 1
}

seed_data() {
  [ "$SEEDED" -eq 1 ] && return 0
  start_server
  echo "--- seeding dev data"
  node scripts/seed-dev.mjs "$PORT" 400 >/dev/null 2>&1
  SEEDED=1
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
RAN=0
for row in "${GATES[@]}"; do
  groups="${row%%|*}"; rest="${row#*|}"
  needs="${rest%%|*}";  rest="${rest#*|}"
  label="${rest%%|*}";  cmd="${rest#*|}"
  selected "$groups" || continue

  case "$needs" in
    srv)  start_server ;;
    seed) seed_data ;;
  esac

  echo "==> $label"
  if [ "$needs" = "seed" ] || [ "$needs" = "srv" ]; then
    BASE_URL="http://localhost:$PORT" eval "$cmd"
  else
    eval "$cmd"
  fi
  status=$?
  RAN=$((RAN + 1))
  if [ "$status" -ne 0 ]; then
    echo ""
    echo "FAILED: $label"
    echo "  reproduce with: BASE_URL=http://localhost:$PORT $cmd"
    exit 1
  fi
done

cleanup; SRV=""

# ---------------------------------------------------------------------------
# Live site. Its own section because "inconclusive" is a third outcome.
#
# Exit 75 (EX_TEMPFAIL) from a live script means Vercel edge mitigation
# challenged this runner, so the app was never actually observed. That is an
# infrastructure condition, NOT a production regression — treat it as a warning
# so the autonomous loop does not raise a false blocker.
# See scripts/live-http.mjs for the classification rules.
# ---------------------------------------------------------------------------
INCONCLUSIVE=75
if selected "live"; then
  echo "==> Live-site e2e (default production; set KB_SKIP_LIVE=1 to skip)"
  if [ "${KB_SKIP_LIVE:-}" = "1" ] || [ "${KB_SKIP_LIVE:-}" = "true" ] || [ "${KB_LIVE_URL:-}" = "skip" ]; then
    echo "[live] KB_SKIP_LIVE — skipping live verification."
    LIVE_OK=0; LIVE_SETTINGS_CLEAR_OK=0; LIVE_CROSS_VIEW_OK=0
  else
    export KB_LIVE_URL="${KB_LIVE_URL:-https://classroom-knowledge.vercel.app}"
    echo "[live] KB_LIVE_URL=$KB_LIVE_URL"
    node scripts/kb_live_test.mjs
    LIVE_OK=$?
    if [ "$LIVE_OK" -eq "$INCONCLUSIVE" ]; then
      # Skip the follow-on smokes: they target the same edge that just refused
      # us, so they would only produce more phantom failures.
      LIVE_SETTINGS_CLEAR_OK=0; LIVE_CROSS_VIEW_OK=0
    elif [ "$LIVE_OK" -eq 0 ]; then
      echo "==> Live Settings clear/rebuild smoke"
      BASE_URL="$KB_LIVE_URL" node scripts/settings_clear_rebuild_test.mjs
      LIVE_SETTINGS_CLEAR_OK=$?
      echo "==> Live cross-view related-retry smoke"
      node scripts/live_cross_view_related_retry_test.mjs
      LIVE_CROSS_VIEW_OK=$?
    else
      LIVE_SETTINGS_CLEAR_OK=1; LIVE_CROSS_VIEW_OK=1
    fi
  fi

  if [ "$LIVE_OK" -eq "$INCONCLUSIVE" ]; then
    echo ""
    echo "WARNING: live checks INCONCLUSIVE — Vercel edge mitigation blocked the runner."
    echo "         Production is NOT known to be broken. Do not open a blocker for this."
    echo "         Confirm by hand from a normal network:"
    echo "           curl -sI $KB_LIVE_URL/ | head -1"
    echo "         Local gates above all passed."
    echo "ALL TESTS PASSED (live verification inconclusive)"
    exit 0
  fi

  # Name what actually failed. "LIVE E2E FAILED (production regression)" used to
  # be printed for all three, including the two follow-on smokes — which sent
  # someone hunting a production fault when the site was healthy and a smoke had
  # simply gone stale against a deliberate app change.
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
fi

if [ "$RAN" -eq 0 ] && ! selected "live"; then
  echo "no gates matched --group '$SELECT'"
  exit 2
fi
echo "ALL TESTS PASSED${SELECT:+ (--group $SELECT, $RAN gates)}"
