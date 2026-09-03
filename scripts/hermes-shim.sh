#!/usr/bin/env bash
# Copy of this file belongs at ~/.hermes/scripts/ckb-gate.sh on the Hermes box,
# because `hermes cron edit --script` only accepts a path under that directory.
# It is a shim on purpose: all real logic lives in the repo, so changing the
# pre-run behaviour is a git push plus a pull, never an edit at the box.
exec bash /opt/data/workspace/Classroom-Knowledge-Base/scripts/pre-run-gate.sh
