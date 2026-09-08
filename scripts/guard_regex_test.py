#!/usr/bin/env python3
"""guard_regex_test.py — the secret scanner catches credentials and nothing else.

The scanner reads `git diff --cached`, which carries three lines of context, so
a false positive blocks commits that merely land NEAR the offending text. That
is what `sk-[A-Za-z0-9]` did: it fired on the "sk-k" inside "task-kinds.js".

Both directions are checked here, because narrowing a security check is exactly
the kind of change that should have to prove it did not stop working.

Usage: python3 scripts/guard_regex_test.py
"""
import importlib.util
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

spec = importlib.util.spec_from_file_location("guard", os.path.join(HERE, "guard.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
SECRET_RE = guard.SECRET_RE

# Fabricated, correctly-shaped credentials. None of these is real, and every one
# is assembled from pieces so that no literal in THIS file is itself a match —
# otherwise the scanner would flag its own test suite and block every commit
# that touches it.
MUST_MATCH = [
    ("OpenAI", "OPENAI_API_KEY=sk-" + "A1b2C3d4E5f6G7h8I9j0" * 2),
    ("OpenAI project", 'const k = "sk-proj-' + "abcdefghij" * 5 + '";'),
    ("NVIDIA", "nvapi-" + "Xy9" * 20),
    ("Groq", "gsk_" + "aB3" * 20),
    ("Cerebras", "csk-" + "9zQ" * 15),
    ("AWS access key", "aws_access_key_id = " + "AKIA" + "IOSFODNN7EXAMPLE"),
    ("GitHub classic PAT", "ghp_" + "0123456789abcdefghij" * 2),
    ("GitHub fine-grained", "github_pat_" + "11ABCDEFG0" * 4),
    ("Google API key", "AIza" + "SyD-1234567890abcdefghijklmnopqrstu"),
    ("Slack bot token", "xoxb-" + "123456789012-1234567890123-abcdefghijklmnopqrstuvwx"),
    ("in a URL query", "https://api.example.com/v1?key=sk-" + "Zz9" * 15),
    ("in JSON", '{"token": "ghp_' + "q" * 36 + '"}'),
]

# Real text from this repository and its neighbourhood.
MUST_NOT_MATCH = [
    ("the reported false positive", 'import { normalizeTaskKind } from "./task-kinds.js";'),
    ("its diff-context form", ' import { normalizeTaskKind } from "./task-kinds.js";'),
    ("a task-kinds path", "scripts/../task-kinds.js"),
    ("prose about tasks", "The task-kind vocabulary is shared by the prompt and the client."),
    ("a risk- word", "risk-free"),
    ("short sk- fragment", "ask-me"),
    ("desk-tidy", "desk-kit"),
    ("word ending in gsk_", "the flagsk_value"),
    ("ghp inside a word", "roughp_edge"),
    ("lowercase akia word", "sakia"),
    ("a slack-ish word", "xoxo-hello"),
]


def main():
    failures = []

    for name, sample in MUST_MATCH:
        if not SECRET_RE.search(sample):
            failures.append(f"MISSED a credential: {name}")

    for name, sample in MUST_NOT_MATCH:
        m = SECRET_RE.search(sample)
        if m:
            failures.append(f"FALSE POSITIVE on {name}: matched {m.group(0)!r} in {sample!r}")

    # Nothing tracked in the repository may trip the scanner. This is the check
    # that would have caught the original defect: the offending string is in a
    # file that has been committed for months.
    tracked = subprocess.run(
        ["git", "ls-files"], cwd=REPO, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    ).stdout.split("\n")
    for path in tracked:
        if not path or path.startswith("scripts/guard_regex_test.py"):
            continue
        full = os.path.join(REPO, path)
        if not os.path.isfile(full):
            continue
        try:
            with open(full, encoding="utf-8", errors="replace") as fh:
                for lineno, line in enumerate(fh, 1):
                    m = SECRET_RE.search(line)
                    if m:
                        failures.append(f"tracked file trips the scanner: {path}:{lineno} matched {m.group(0)!r}")
        except OSError:
            continue

    if failures:
        for f in failures:
            print(f"  ✗ {f}")
        print(f"\nguard regex tests FAILED ({len(failures)} issue(s))")
        return 1

    print(f"✓ guard secret scanner: {len(MUST_MATCH)} credential shapes caught, "
          f"{len(MUST_NOT_MATCH)} lookalikes ignored, no tracked file trips it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
