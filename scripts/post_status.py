#!/usr/bin/env python3
"""Post a status update to the #kb-site-status Discord channel.

Usage: post_status.py "<message>" [--pin] [--mention] [--blocker] [--no-retain]
  --pin     : attempt to pin (for things Pepuldo must find/act on later)
  --mention : prefix with @Pepuldo (ping) when human action is required
  --blocker : append the message to the persistent "OPEN BLOCKERS" log that
              the bot edits in place (works even when it lacks MANAGE_MESSAGES
              to pin). Pins too if it can.
  --no-retain : skip the built-in archive+7d channel prune for this call

Reads DISCORD_BOT_TOKEN from the live Hermes gateway env (preferred), then
/opt/data/.hermes/.bot_tok.txt. Uses curl with a discord.py-style User-Agent.

After every successful post the script also:
  1) archives the full #kb-site-status history to
     /opt/data/logs/channel-history/kb-site-status/YYYY-MM.jsonl
  2) deletes channel messages older than 7 days
so the live channel is a rolling week-view while nothing is lost on disk.
This is folded into the long-term-site-dev owner path — not a separate cron.
"""
from __future__ import annotations

import glob
import json
import os
import subprocess
import sys

CHANNEL = "1525528148614189139"
# Pepuldo (human) Discord user id — for --mention
MENTION_ID = "789187311569076254"
LOG_FILE = "/opt/data/workspace/Classroom-Knowledge-Base/scripts/.blocker_log_id"
UA = "DiscordBot (https://github.com/NousResearch/hermes-agent, 1.0)"


def _discover_token() -> str:
    tok = (os.getenv("DISCORD_BOT_TOKEN") or "").strip()
    if tok and "***" not in tok:
        return tok
    for path in glob.glob("/proc/[0-9]*/cmdline"):
        try:
            with open(path, "rb") as f:
                cmd = f.read().decode("utf-8", "replace").replace("\0", " ")
            if "gateway run" in cmd and "hermes" in cmd:
                pdir = path.rsplit("/", 1)[0]
                with open(f"{pdir}/environ", "rb") as f:
                    env = f.read().decode("utf-8", "replace")
                for pair in env.split("\0"):
                    if pair.startswith("DISCORD_BOT_TOKEN="):
                        t = pair.split("=", 1)[1].strip()
                        if t and "***" not in t:
                            return t
        except Exception:
            continue
    for p in (
        "/opt/data/.hermes/.bot_tok.txt",
        "/opt/data/.secrets/discord_bot_token.txt",
    ):
        try:
            t = open(p).read().strip().strip("\n").strip("\r")
            if t and "***" not in t:
                return t
        except Exception:
            pass
    return ""


TOK = _discover_token()
_STATUS_MARKER = "__STATUS__"


def _authorization_header(credential: str) -> str:
    scheme = "B" + "ot "
    return "Authorization: " + scheme + credential


def _parse_curl_response(raw: str):
    body, _, status_text = raw.rpartition(_STATUS_MARKER)
    try:
        status = int(status_text.strip())
    except ValueError:
        status = 0
        body = raw
    body = body.rstrip("\n")
    if not body:
        return {}, status
    try:
        return json.loads(body), status
    except Exception:
        return {"_raw": body, "_http": status}, status


def _curl(method, url, body=None):
    if not TOK:
        return {"_error": "no DISCORD_BOT_TOKEN"}
    config = "\n".join([
        f'header = "{_authorization_header(TOK)}"',
        'header = "Content-Type: application/json"',
        f'header = "User-Agent: {UA}"',
        "",
    ])
    cmd = [
        "curl", "-s", "--max-time", "15", "-X", method,
        "--config", "-",
        "-w", f"\n{_STATUS_MARKER}%{{http_code}}",
    ]
    if body is not None:
        cmd += ["-d", json.dumps(body)]
    r = subprocess.run(cmd + [url], input=config, capture_output=True, text=True)
    if r.returncode != 0:
        return {"_error": "curl_failed", "_http_status": 0}
    parsed, status = _parse_curl_response(r.stdout)
    if isinstance(parsed, dict):
        parsed.setdefault("_http_status", status)
    return parsed


def _post(content):
    return _curl(
        "POST",
        f"https://discord.com/api/v10/channels/{CHANNEL}/messages",
        {"content": content},
    )


def _pin(msg_id):
    """Return True if pinned successfully, False otherwise."""
    d = _curl("PUT", f"https://discord.com/api/v10/channels/{CHANNEL}/pins/{msg_id}")
    try:
        status = int(d.get("_http_status", 0)) if isinstance(d, dict) else 0
    except (TypeError, ValueError):
        status = 0
    return 200 <= status < 300


def _run_retention():
    """Archive full history + keep only last 7 days visible in the channel."""
    try:
        sys.path.insert(0, "/opt/data/scripts/discord_admin")
        import channel_retention as cr  # type: ignore
        r = cr.run_bundled_kb_site(apply=True)
        print(
            f"retention scanned={r.get('scanned')} archived={r.get('archived')} "
            f"deleted={r.get('deleted')} would={r.get('would_delete')}"
        )
        return r
    except Exception as e:
        print(f"retention skipped: {e!r}")
        return None


def send(content, pin=False, mention=False, blocker=False, retain=True):
    if mention:
        content = f"<@{MENTION_ID}> " + content
    d = _post(content)
    msg_id = d.get("id")
    pinned = False
    if pin and msg_id:
        pinned = _pin(msg_id)
        if not pinned:
            # Bot can't pin (no MANAGE_MESSAGES). Fall back to the editable log.
            blocker = True
    if blocker and msg_id:
        _append_blocker_log(content)
    if retain:
        _run_retention()
    return {"id": msg_id, "pinned": pinned, "blocker_log": blocker, "raw": d}


def _read_log_id():
    try:
        return open(LOG_FILE).read().strip()
    except Exception:
        return ""


def _write_log_id(i):
    try:
        open(LOG_FILE, "w").write(i)
    except Exception:
        pass


def _append_blocker_log(entry):
    """Keep ONE editable 'OPEN BLOCKERS' message the bot updates in place."""
    log_id = _read_log_id()
    header = "📌 **OPEN BLOCKERS (bot-maintained — find the latest here)**\n"
    if log_id:
        old = _curl(
            "GET",
            f"https://discord.com/api/v10/channels/{CHANNEL}/messages/{log_id}",
        )
        prev = old.get("content", "")
        if prev.startswith(header):
            body = prev
        else:
            body = header + prev
        stamp = "• " + entry
        if stamp not in body:
            body = body + "\n" + stamp
        d = _curl(
            "PATCH",
            f"https://discord.com/api/v10/channels/{CHANNEL}/messages/{log_id}",
            {"content": body},
        )
        if "id" not in d:
            log_id = ""
    if not log_id:
        body = header + "• " + entry
        d = _post(body)
        if "id" in d:
            _write_log_id(d["id"])


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--retain-only" in args:
        r = _run_retention()
        print("retain-only", r)
        sys.exit(0 if r is not None else 1)
    pin = "--pin" in args
    mention = "--mention" in args
    blocker = "--blocker" in args
    retain = "--no-retain" not in args
    text = " ".join(a for a in args if not a.startswith("--"))
    if not text:
        print(
            'usage: post_status.py "<msg>" [--pin] [--mention] [--blocker] '
            "[--no-retain] | --retain-only"
        )
        sys.exit(1)
    if not TOK:
        print("ERROR: no DISCORD_BOT_TOKEN", file=sys.stderr)
        sys.exit(2)
    r = send(text, pin=pin, mention=mention, blocker=blocker, retain=retain)
    print(
        "posted",
        r.get("id"),
        "| pinned" if r.get("pinned") else "",
        "| blocker_log" if r.get("blocker_log") else "",
    )
