#!/usr/bin/env python3
"""Post a status update to the #kb-site-status Discord channel.

Usage: post_status.py "<message>" [--pin] [--mention] [--blocker]
  --pin     : attempt to pin (for things Pepuldo must find/act on later)
  --mention : prefix with @Pepuldo (ping) when human action is required
  --blocker : append the message to the persistent "OPEN BLOCKERS" log that
              the bot edits in place (works even when it lacks MANAGE_MESSAGES
              to pin). Pins too if it can.

Reads DISCORD_BOT_TOKEN from /opt/data/.hermes/.bot_tok.txt.
Uses curl (Discord rejects urllib's default User-Agent).

NOTE: pinning requires the bot to have MANAGE_MESSAGES in the channel. If the
bot lacks it (HTTP 403), the pin is skipped and the message is instead added to
the editable OPEN-BLOCKERS log, which needs no special permission and stays
findable because the bot keeps updating the same message.
"""
import sys, subprocess, json, os

CHANNEL = "1525528148614189139"
TOK = open("/opt/data/.hermes/.bot_tok.txt").read().strip().strip("\n").strip("\r")
MENTION_ID = "1524052694870790184"  # Pepuldo's Discord user id
LOG_FILE = "/opt/data/workspace/Classroom-Knowledge-Base/scripts/.blocker_log_id"  # last log msg id

def _curl(method, url, body=None):
    cmd = ["curl", "-s", "--max-time", "15", "-X", method,
           "-H", f"Authorization: Bot {TOK}",
           "-H", "Content-Type: application/json"]
    if body is not None:
        cmd += ["-d", json.dumps(body)]
    r = subprocess.run(cmd + [url], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"_raw": r.stdout, "_http": r.returncode}

def _post(content):
    return _curl("POST", f"https://discord.com/api/v10/channels/{CHANNEL}/messages", {"content": content})

def _pin(msg_id):
    """Return True if pinned successfully, False otherwise."""
    d = _curl("PUT", f"https://discord.com/api/v10/channels/{CHANNEL}/pins/{msg_id}")
    return "id" in d or d == {}  # empty {} on success

def send(content, pin=False, mention=False, blocker=False):
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
    return {"id": msg_id, "pinned": pinned, "blocker_log": blocker}

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
        # fetch existing to preserve prior entries
        old = _curl("GET", f"https://discord.com/api/v10/channels/{CHANNEL}/messages/{log_id}")
        prev = old.get("content", "")
        if prev.startswith(header):
            body = prev
        else:
            body = header + prev
        stamp = "• " + entry
        if stamp not in body:
            body = body + "\n" + stamp
        d = _curl("PATCH", f"https://discord.com/api/v10/channels/{CHANNEL}/messages/{log_id}", {"content": body})
        if "id" not in d:  # log msg deleted or unusable -> recreate
            log_id = ""
    if not log_id:
        body = header + "• " + entry
        d = _post(body)
        if "id" in d:
            _write_log_id(d["id"])

if __name__ == "__main__":
    args = sys.argv[1:]
    pin = "--pin" in args
    mention = "--mention" in args
    blocker = "--blocker" in args
    text = " ".join(a for a in args if not a.startswith("--"))
    if not text:
        print("usage: post_status.py \"<msg>\" [--pin] [--mention] [--blocker]"); sys.exit(1)
    r = send(text, pin=pin, mention=mention, blocker=blocker)
    print("posted", r.get("id"), "| pinned" if r.get("pinned") else "", "| blocker_log" if r.get("blocker_log") else "")
