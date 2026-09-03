#!/usr/bin/env bash
# gate.sh — run the full test gate out of band and record a result the loop can read.
#
# WHY THIS EXISTS
#   The agent's shell tool (`shell.exec` in tui_gateway/server.py) runs every
#   command under `subprocess.run(..., timeout=30)`. Thirty seconds. The full
#   gate in scripts/test.sh needs minutes, so `bash scripts/test.sh 4321` has
#   never once run to completion from inside the loop — it returns 124 every
#   time, which is the timeout, not a test result. A verdict narrated around a
#   124 is a verdict with no gate behind it.
#
#   So the gate does not run from the loop any more. A deterministic cron job
#   (script: set, no agent) calls `gate.sh run`, and the loop reads the recorded
#   result with `gate.sh status` — one instant command, well inside 30s.
#
# THE CONTRACT
#   A recorded result belongs to the commit named in GATE_SHA and to nothing
#   else. If the loop's HEAD is not GATE_SHA, the gate has not seen its change
#   and it may not claim verification. GATE_DIRTY=1 means the tree had
#   uncommitted edits when the gate ran, so the result maps to no commit at all.
#
# Usage:
#   bash scripts/gate.sh run      # cron entry point; runs the gate, records result
#   bash scripts/gate.sh status   # print the recorded result (what the loop runs)
#   bash scripts/gate.sh tail     # last 60 lines of the recorded gate output
#   bash scripts/gate.sh start    # on-demand: launch `run` detached, return now

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GATE_DIR="$ROOT/.gate"
RESULT="$GATE_DIR/result.env"
FULL_LOG="$GATE_DIR/gate.log"
TAIL_LOG="$GATE_DIR/tail.log"
PORT="${GATE_PORT:-4321}"

# Hard ceiling so a wedged browser test cannot leave the result stuck at RUNNING
# forever. Cron fires every 3h; 45 min is generous and still well clear of it.
MAX_SECONDS="${GATE_MAX_SECONDS:-2700}"

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

cmd_run() {
  mkdir -p "$GATE_DIR"

  local sha dirty started started_epoch
  sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  # Tracked modifications only (-uno). Untracked files must NOT count as
  # dirty: the workspace permanently carries build noise (.playwright/,
  # server.log) and test.sh names every file it runs, so an untracked file
  # cannot change what the gate measures. Counting them would pin
  # GATE_DIRTY=1 forever, making GATE_APPLIES_TO_HEAD permanently "no"
  # and the gate permanently unusable.
  if [ -n "$(git status --porcelain -uno 2>/dev/null)" ]; then dirty=1; else dirty=0; fi
  started="$(now_utc)"
  started_epoch="$(date -u +%s)"

  # Publish RUNNING before starting, so a status read during the gate is honest
  # rather than showing a stale PASS from the previous run.
  {
    echo "GATE_VERDICT=RUNNING"
    echo "GATE_SHA=$sha"
    echo "GATE_DIRTY=$dirty"
    echo "GATE_STARTED_AT=$started"
    echo "GATE_FINISHED_AT="
    echo "GATE_EXIT="
    echo "GATE_DURATION_S="
  } > "$RESULT"

  timeout "$MAX_SECONDS" bash "$ROOT/scripts/test.sh" "$PORT" > "$FULL_LOG" 2>&1
  local exit_code=$?

  local finished_epoch duration verdict
  finished_epoch="$(date -u +%s)"
  duration=$((finished_epoch - started_epoch))

  # test.sh already folds live-check exit 75 into exit 0 and says so in its last
  # line; surface that as its own verdict rather than an unqualified PASS.
  if [ "$exit_code" -eq 124 ]; then
    verdict=TIMEOUT
  elif [ "$exit_code" -ne 0 ]; then
    verdict=FAIL
  elif grep -q "live verification inconclusive" "$FULL_LOG" 2>/dev/null; then
    verdict=INCONCLUSIVE
  else
    verdict=PASS
  fi

  tail -n 60 "$FULL_LOG" > "$TAIL_LOG" 2>/dev/null || true

  {
    echo "GATE_VERDICT=$verdict"
    echo "GATE_SHA=$sha"
    echo "GATE_DIRTY=$dirty"
    echo "GATE_STARTED_AT=$started"
    echo "GATE_FINISHED_AT=$(now_utc)"
    echo "GATE_EXIT=$exit_code"
    echo "GATE_DURATION_S=$duration"
  } > "$RESULT"

  cat "$RESULT"
  return 0
}

cmd_status() {
  if [ ! -f "$RESULT" ]; then
    echo "GATE_VERDICT=NEVER_RUN"
    echo "GATE_SHA="
    echo "HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "GATE_APPLIES_TO_HEAD=no"
    return 0
  fi

  cat "$RESULT"

  local head_sha gate_sha gate_dirty
  head_sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  gate_sha="$(grep '^GATE_SHA=' "$RESULT" | cut -d= -f2-)"
  gate_dirty="$(grep '^GATE_DIRTY=' "$RESULT" | cut -d= -f2-)"

  echo "HEAD_SHA=$head_sha"
  # The single line the loop should key off. Anything but "yes" means the
  # recorded verdict says nothing about the code currently checked out.
  if [ "$gate_dirty" = "1" ]; then
    echo "GATE_APPLIES_TO_HEAD=no"
  elif [ -n "$gate_sha" ] && [ "$gate_sha" = "$head_sha" ]; then
    echo "GATE_APPLIES_TO_HEAD=yes"
  else
    echo "GATE_APPLIES_TO_HEAD=no"
  fi
}

cmd_tail() {
  if [ -f "$TAIL_LOG" ]; then cat "$TAIL_LOG"; else echo "no recorded gate output"; fi
}

cmd_start() {
  mkdir -p "$GATE_DIR"
  setsid nohup bash "$ROOT/scripts/gate.sh" run > /dev/null 2>&1 < /dev/null &
  echo "GATE_LAUNCHED=yes"
  echo "poll with: bash scripts/gate.sh status"
}

case "${1:-status}" in
  run)    cmd_run ;;
  status) cmd_status ;;
  tail)   cmd_tail ;;
  start)  cmd_start ;;
  *)
    echo "usage: bash scripts/gate.sh {run|status|tail|start}" >&2
    exit 2
    ;;
esac
