#!/usr/bin/env bash
# deploy.sh — deploy the Classroom Knowledge Base to Vercel production.
# Requires VERCEL_TOKEN (runtime cred, stored in /opt/data/.hermes/vercel_token.txt).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TOKEN="${VERCEL_TOKEN:-$(cat /opt/data/.hermes/vercel_token.txt 2>/dev/null)}"
if [ -z "$TOKEN" ]; then echo "ERROR: VERCEL_TOKEN not set"; exit 1; fi
export PATH="$PWD/node_modules/.bin:$PATH"
export VERCEL_TOKEN="$TOKEN"
# ensure project linked (idempotent)
vercel link --project classroom-knowledge-google --yes --token "$TOKEN" >/dev/null 2>&1 || true
vercel deploy --prod --token "$TOKEN" --yes 2>&1 | tail -6
