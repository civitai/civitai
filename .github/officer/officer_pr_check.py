#!/usr/bin/env python3
"""officer_pr_check.py: the second wall for PRs opened by an officer agent's GitHub App.

Usage:
  officer_pr_check.py arm   <base-rev> <head-ref-name> <author-login>
  officer_pr_check.py check <base-rev> <head-rev>

`arm` decides whether the check applies. Armed when EITHER the head ref starts with
`officer/` OR the author is listed (case-insensitively) in the BASE revision's
.github/officer/bot-logins.txt. Prints `armed=true` or `armed=false` and a `why:` line.
Exit 2 (fail closed) on an empty ref or author, or when an author must be checked and the
base lacks the list.

`check` judges every path changed between <base-rev> and <head-rev> (both sides of a
rename, deletions included):
  1. ALLOWLIST: the path must be under one of ALLOWED_ROOTS (src/, packages/).
  2. FORBIDDEN: the path must match no glob of the BASE revision's
     .github/officer/forbidden-paths.txt (the grammar of the agent's push gate, ported:
     match_forbidden below).
  3. MODE: no symlink (120000) or gitlink (160000) may be added or changed to.
  4. REGRESSION TEST: at least one added or modified file is a test (TEST_GLOBS: a
     `*.test.*` / `*.spec.*` file or anything under a `__tests__/` directory). Every officer
     PR must carry a regression test for the fault it fixes (operator decision 2026-11-09);
     a deleted test does not count.
An empty diff FAILS: an officer PR always changes something, and "nothing changed" more
often means wrong revisions than a clean PR.

🔴 FAIL CLOSED: the list and the logins are read from <base-rev> with `git show` and from
nowhere else. The workflow also runs THIS FILE from the base, never the PR's copy.

Exit status: 0 pass, 1 a check failed, 2 usage, environment or missing-input error.
Python 3 standard library only.
"""
import re
import subprocess
import sys

LIST = ".github/officer/forbidden-paths.txt"
LOGINS = ".github/officer/bot-logins.txt"
ALLOWED_ROOTS = ("src/", "packages/")
BRANCH_PREFIX = "officer/"
BAD_MODES = {"120000": "a symlink", "160000": "a submodule gitlink"}
TEST_GLOBS = ("*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", "*.spec.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", "__tests__")


class Fatal(Exception):
    """An environment or input error: exit 2."""


# ── the push gate's glob grammar, ported ────────────────────────────────────────
def _segment_regex(seg):
    out, i = [], 0
    while i < len(seg):
        c = seg[i]
        if c == "*":
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        elif c == "{":
            j = seg.find("}", i)
            if j < 0:
                raise ValueError("has an unbalanced '{'")
            body = seg[i + 1:j]
            if "{" in body or body == "":
                raise ValueError("has a nested or empty '{...}'")
            alts = []
            for a in body.split(","):
                if a == "":
                    raise ValueError("has an empty alternative in '{...}'")
                alts.append(_segment_regex(a))
            out.append("(?:" + "|".join(alts) + ")")
            i = j
        elif c == "}":
            raise ValueError("has an unbalanced '}'")
        else:
            out.append(re.escape(c))
        i += 1
    return "".join(out)


def compile_glob(pat):
    """The pattern as an anchored regexp; ValueError when the push gate would refuse it."""
    if pat == "" or pat.startswith("/"):
        raise ValueError("must be a non-empty repository-relative pattern")
    if any(c in pat for c in "[]\\"):
        raise ValueError("character classes and escapes are not supported")
    if pat.endswith("/"):
        pat += "**"
    segs = pat.split("/")
    out = ["^"]
    for i, seg in enumerate(segs):
        last = i == len(segs) - 1
        if seg in ("", ".", ".."):
            raise ValueError("has an empty, '.' or '..' segment")
        if seg == "**":
            out.append(".+" if last else "(?:[^/]+/)*")
            continue
        if "**" in seg:
            raise ValueError("`**` must be a whole segment")
        out.append(_segment_regex(seg))
        if not last:
            out.append("/")
    out.append("$")
    # DOTALL and fullmatch: a newline in a path is matched like any other character (Go's
    # `.` would not match it), so this side is never the laxer one.
    return re.compile("".join(out), re.DOTALL)


def match_forbidden(pat, path):
    """Does `path` match `pat`? A pattern with no '/' is tried against every segment."""
    try:
        rx = compile_glob(pat)
    except ValueError:
        return True  # a broken brick is not a gap
    if "/" not in pat:
        return any(rx.fullmatch(seg) for seg in path.split("/"))
    return bool(rx.fullmatch(path))


def parse_list(content):
    """One glob per line; blank and `#` lines skipped. Any invalid line is an error."""
    out = []
    for n, line in enumerate(content.replace("\r\n", "\n").split("\n"), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            compile_glob(line)
        except ValueError as e:
            raise Fatal(f"{LIST} line {n} {line!r}: {e}")
        out.append(line)
    return out


# ── git ─────────────────────────────────────────────────────────────────────────
def git(*args):
    r = subprocess.run(["git", "-c", "core.quotePath=false", *args], capture_output=True)
    if r.returncode != 0:
        raise Fatal(f"git {' '.join(args)}: {r.stderr.decode(errors='replace').strip()}")
    return r.stdout


def from_base(base, path):
    r = subprocess.run(["git", "cat-file", "-e", f"{base}:{path}"], capture_output=True)
    if r.returncode != 0:
        raise Fatal(f"{path} is not on the base revision {base}; refusing to fall back to the PR's copy (fail closed)")
    return git("show", f"{base}:{path}").decode("utf-8", errors="replace")


def resolve(rev):
    r = subprocess.run(["git", "rev-parse", "--verify", "-q", f"{rev}^{{commit}}"], capture_output=True)
    if r.returncode != 0:
        raise Fatal(f"revision {rev!r} does not resolve to a commit")
    return r.stdout.decode().strip()


def changed_entries(base, head):
    """[(old_mode, new_mode, status, path)] from `git diff --raw -z --no-renames`."""
    raw = git("diff", "--raw", "-z", "--no-renames", "--no-abbrev", base, head)
    parts = raw.split(b"\0")
    out, i = [], 0
    while i < len(parts) and parts[i]:
        meta = parts[i].decode()
        if not meta.startswith(":"):
            raise Fatal(f"unexpected git diff --raw record {meta!r}")
        old_mode, new_mode, _, _, status = meta[1:].split(" ")
        out.append((old_mode, new_mode, status, parts[i + 1].decode("utf-8", errors="surrogateescape")))
        i += 2
    return out


# ── commands ────────────────────────────────────────────────────────────────────
def cmd_arm(base, ref, author):
    if not ref or not author:
        raise Fatal("empty head ref or author; cannot decide whether the officer check applies (fail closed)")
    if ref.startswith(BRANCH_PREFIX):
        print("armed=true")
        print(f"why: {BRANCH_PREFIX} head ref {ref}")
        return 0
    resolve(base)
    want = author.lower()
    for line in from_base(base, LOGINS).replace("\r", "").split("\n"):
        line = "".join(line.split("#", 1)[0].split())
        if line and line.lower() == want:
            print("armed=true")
            print(f"why: officer bot author {author}")
            return 0
    print("armed=false")
    print(f"why: head ref is not {BRANCH_PREFIX}* and author {author} is not a listed officer bot")
    return 0


def cmd_check(base, head):
    base_c, head_c = resolve(base), resolve(head)
    globs = parse_list(from_base(base_c, LIST))
    if not globs:
        raise Fatal(f"{LIST} on {base} holds no patterns")
    entries = changed_entries(base_c, head_c)
    print(f"== officer PR check: {len(entries)} changed path(s), base {base_c[:12]}, head {head_c[:12]}, "
          f"{len(globs)} forbidden pattern(s) from the base, allowed roots {', '.join(ALLOWED_ROOTS)}")
    if not entries:
        print("FAIL: no changed paths between base and head. Wrong revisions?")
        return 1
    violations, tests = [], []
    for old_mode, new_mode, status, path in entries:
        if status != "D" and any(match_forbidden(g, path) for g in TEST_GLOBS):
            tests.append(path)
        why = []
        if not path.startswith(ALLOWED_ROOTS):
            why.append("outside the allowed roots")
        hit = next((g for g in globs if match_forbidden(g, path)), None)
        if hit:
            why.append(f"matches forbidden pattern {hit}")
        if status != "D" and new_mode in BAD_MODES:
            why.append(f"is {BAD_MODES[new_mode]}")
        if why:
            violations.append(f"  {path!r} [{status}]: {'; '.join(why)}")
    rc = 0
    if violations:
        print(f"FAIL: {len(violations)} path(s) an officer PR may not change:")
        print("\n".join(violations))
        rc = 1
    else:
        print("ok: every changed path is application code under an allowed root")
    if tests:
        print(f"ok: {len(tests)} test file(s) added or modified (the regression test), e.g. {tests[0]!r}")
    else:
        print("FAIL: no test file added or modified; an officer PR must include a regression test "
              f"(a file matching one of {', '.join(TEST_GLOBS)})")
        rc = 1
    return rc


def main(argv):
    try:
        if len(argv) == 5 and argv[1] == "arm":
            return cmd_arm(argv[2], argv[3], argv[4])
        if len(argv) == 4 and argv[1] == "check":
            return cmd_check(argv[2], argv[3])
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    except Fatal as e:
        print(f"FATAL: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
