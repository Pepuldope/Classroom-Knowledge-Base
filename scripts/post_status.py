#!/usr/bin/env python3
"""Post a status update to the #kb-site-status Discord channel.
Usage: post_status.py "<message>" [--pin] [--mention]
- --pin     : pin the message (for things Pepuldo must find/act on)
- --mention : prefix with @Pepuldo (ping) when human action is required
Reads DISCORD_BOT_TOKEN from /opt/data/.hermes/.bot_tok.txt.
Uses curl (Discord rejects urllib's default User-Agent).
"""
import sys, subprocess, json

CHANNEL = "1525528148614189139"
TOK = open("/opt/data/.hermes/.bot_tok.txt").read().strip().strip("\n").strip("\r")
MENTION_ID = "1524052694870790184"  # Pepuldo's Discord user id

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
        return {"_raw": r.stdout}

def send(content, pin=False, mention=False):
    if mention:
        content = f"<@{MENTION_ID}> " + content
    d = _curl("POST", f"https://discord.com/api/v10/channels/{CHANNEL}/messages", {"content": content})
    if pin and "id" in d:
        _curl("PUT", f"https://discord.com/api/v10/channels/{CHANNEL}/pins/{d['id']}")
    return d

if __name__ == "__main__":
    args = sys.argv[1:]
    pin = "--pin" in args
    mention = "--mention" in args
    text = " ".join(a for a in args if not a.startswith("--"))
    d = send(text, pin=pin, mention=mention)
    print("posted", d.get("id"), "| pinned" if pin else "")
