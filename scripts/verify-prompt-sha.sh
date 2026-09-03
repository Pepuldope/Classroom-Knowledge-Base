#!/usr/bin/env bash
# verify-prompt-sha.sh — read the prompt Hermes actually stored for a cron job
# and print its length and sha256, so an install can be checked rather than
# trusted.
#
# WHY THIS IS A FILE AND NOT A ONE-LINER
#   Doing this inline needs `jq -r '.[]|select(.id=="...")|.prompt'` or a
#   `python3 -c` -- both wall-to-wall quotes. Quotes are precisely what the
#   Hermes transport corrupts (tools/fuzzy_match.py:96: "the model typed an
#   apostrophe/quote and the transport added a stray backslash"). A verifier
#   mangled in transit fails open: it prints a hash for something other than
#   what is stored. Shipping it through git means the bytes are already checked
#   before it runs.
#
# Usage: bash scripts/verify-prompt-sha.sh [job_id]

set -u

JOB_ID="${1:-7d8621d78903}"

JOBS=""
for candidate in \
  /opt/data/cron/jobs.json \
  /opt/data/.hermes/cron/jobs.json \
  /opt/data/home/.hermes/cron/jobs.json \
  "$HOME/.hermes/cron/jobs.json"
do
  if [ -f "$candidate" ]; then JOBS="$candidate"; break; fi
done

if [ -z "$JOBS" ]; then
  echo "JOBS_JSON=not-found"
  exit 0
fi

echo "JOBS_JSON=$JOBS"

python3 - "$JOBS" "$JOB_ID" <<'PYEOF'
import hashlib, json, sys

path, job_id = sys.argv[1], sys.argv[2]

try:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
except Exception as exc:
    print("PARSE_ERROR=%s" % exc)
    raise SystemExit(0)

# jobs.json has been seen both as a bare list and as {"jobs": [...]}; accept
# either rather than guessing, and accept a dict keyed by job id too.
if isinstance(data, dict):
    jobs = data.get("jobs", data)
else:
    jobs = data
if isinstance(jobs, dict):
    jobs = list(jobs.values())

job = None
for entry in jobs or []:
    if isinstance(entry, dict) and entry.get("id") == job_id:
        job = entry
        break

if job is None:
    print("JOB_FOUND=no")
    raise SystemExit(0)

print("JOB_FOUND=yes")
print("JOB_NAME=%s" % job.get("name"))
print("SCRIPT=%s" % job.get("script"))
print("NO_AGENT=%s" % job.get("no_agent"))
print("WORKDIR=%s" % job.get("workdir"))

prompt = job.get("prompt")
if not isinstance(prompt, str):
    print("PROMPT=missing")
    raise SystemExit(0)

raw = prompt.encode("utf-8")
print("PROMPT_BYTES=%d" % len(raw))
print("PROMPT_SHA256=%s" % hashlib.sha256(raw).hexdigest())

# The transport corrupts by ADDING backslashes, so count the sequences that
# would prove it happened to this payload in flight.
print("BACKSLASH_COUNT=%d" % prompt.count("\\"))
PYEOF
