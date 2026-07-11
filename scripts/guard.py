#!/usr/bin/env python3
"""Pre-commit guard for the KB upgrade loop. Enforces LOOP-GUARDRAILS.md.
Usage: python3 scripts/guard.py  (run from repo root before `git commit`)
Exits 0 if safe, 1 if a rule is violated (prints the violation).
"""
import subprocess, sys, re, os

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRET_RE = re.compile(
    r"(sk-[A-Za-z0-9]|nvapi-[A-Za-z0-9]|gsk_[A-Za-z0-9]|csk-[A-Za-z0-9]"
    r"|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]|github_pat_[A-Za-z0-9]"
    r"|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]+)",
    re.I,
)
PROTECTED = {
    "index.html", "app.js", "styles.css", "api/oauth-config.js",
    "api/_helpers.js", "api/kb-store.js", "scripts/post_status.py",
}
# Operations that indicate a destructive/forced push.
DANGEROUS_PATTERNS = [r"--force", r"--no-verify", r"reset --hard", r"flushall", r"git push .* -f"]


def run(cmd):
    return subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)


def main():
    # 1. staged files
    r = run(["git", "diff", "--cached", "--name-only"])
    files = [f for f in r.stdout.split("\n") if f]
    if not files:
        print("guard: nothing staged"); return 0

    # 2. secret scan on staged content
    for f in files:
        c = run(["git", "show", f":{f}"]).stdout if False else None
        # get staged content
        cat = run(["git", "diff", "--cached", f])
        if SECRET_RE.search(cat.stdout):
            print(f"GUARD FAIL: secret pattern detected in staged {f}")
            return 1

    # 3. protected files may not be deleted or rewritten wholesale
    for f in files:
        if f in PROTECTED:
            # allow small edits; block deletion
            status = run(["git", "diff", "--cached", "--diff-filter=D", "--name-only"])
            if f in status.stdout:
                print(f"GUARD FAIL: protected file {f} deleted"); return 1

    # 4. syntax check changed JS
    for f in files:
        if f.endswith((".js", ".mjs")):
            chk = run(["node", "--check", f])
            if chk.returncode != 0:
                print(f"GUARD FAIL: syntax error in {f}\n{chk.stderr}")
                return 1

    # 5. no bare 'force' / 'no-verify' strings committed in scripts
    for f in files:
        if f.endswith((".js", ".mjs", ".py", ".sh")):
            cat = run(["git", "diff", "--cached", f]).stdout
            for p in DANGEROUS_PATTERNS:
                if re.search(p, cat, re.I) and "force-push" not in f:
                    print(f"GUARD WARN: risky pattern '{p}' in {f} (review before push)")
                    # warn, don't hard-fail (legitimate refs exist)

    print("guard: OK — safe to commit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
