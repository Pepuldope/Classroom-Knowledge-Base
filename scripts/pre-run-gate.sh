#!/usr/bin/env bash
# pre-run-gate.sh — runs before the long-term-site-dev agent on every tick.
#
# Attached with `hermes cron edit 7d8621d78903 --script <shim>`. In agent mode
# the script's STDOUT IS INJECTED INTO THE AGENT'S PROMPT, so the gate verdict
# arrives as an input the loop cannot skip, forget, or narrate around -- rather
# than something it is merely instructed to go and fetch.
#
# Two consequences for anything edited here:
#   1. Stdout is prompt text, not a log. Keep it to a few short lines. The gate's
#      own output goes to .gate/gate.log and must never be echoed here.
#   2. Never exit non-zero and never hang. A broken pre-run script degrades every
#      tick of the job. Every failure path below prints something and exits 0.
#
# The gate is only re-run when the recorded result does not already cover the
# checked-out commit, so a quiet tick on an unchanged tree costs nothing.

set -u

ROOT="/opt/data/workspace/Classroom-Knowledge-Base"

if ! cd "$ROOT" 2>/dev/null; then
  echo "=== GATE RESULT ==="
  echo "GATE_VERDICT=UNAVAILABLE"
  echo "GATE_NOTE=workspace not found at $ROOT"
  echo "=== END GATE RESULT ==="
  exit 0
fi

RESULT="$ROOT/.gate/result.env"

head_sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
gate_sha=""
verdict=""
if [ -f "$RESULT" ]; then
  gate_sha="$(grep '^GATE_SHA=' "$RESULT" 2>/dev/null | cut -d= -f2-)"
  verdict="$(grep '^GATE_VERDICT=' "$RESULT" 2>/dev/null | cut -d= -f2-)"
fi

# Re-run only when the recording does not already belong to this commit. A
# RUNNING verdict means a previous run died before recording, so redo it.
if [ -z "$verdict" ] || [ "$verdict" = "RUNNING" ] || [ "$gate_sha" != "$head_sha" ]; then
  bash "$ROOT/scripts/gate.sh" run > /dev/null 2>&1 || true
fi

echo "=== GATE RESULT (recorded before this run; you did not produce it) ==="
bash "$ROOT/scripts/gate.sh" status 2>/dev/null || echo "GATE_VERDICT=UNAVAILABLE"
echo "=== END GATE RESULT ==="

exit 0
