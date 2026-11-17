#!/usr/bin/env python3
"""officer_pr_check.py: the second wall for PRs opened by an officer agent's GitHub App.

Usage:
  officer_pr_check.py arm   <base-rev> <head-rev> <base-ref-name> <head-ref-name> <author-login> <sender-login>
  officer_pr_check.py check <base-rev> <head-rev>
  officer_pr_check.py selftest-needed <base-rev> <rev>

`arm` decides whether the check applies. Armed when ANY of these holds:
  * the head ref starts with `officer/`;
  * the PR author, or the event's sender, is listed (case-insensitively) in the BASE
    revision's .github/officer/bot-logins.txt;
  * a commit in <base-rev>..<head-rev> has a listed login as its author or committer, by
    name or by GitHub's noreply email (`[<id>+]<login>@users.noreply.github.com`).
Prints `armed=true` or `armed=false` and a `why:` line. An armed PR whose base ref is not
`main` FAILS (exit 1): officer PRs target main only, and the list a PR is judged by must be
main's. Exit 2 (fail closed) on an empty argument, when logins must be read and the base
lacks the list, or when a shallow history cuts <base-rev>..<head-rev> short (a bot commit
could hide past the cut).

`selftest-needed` decides whether the self-test has anything to say about a PR: it prints
`selftest=true` when <base-rev>..<rev> touches .github/officer/ or adds a top-level entry
(which forbidden-paths.txt must then list), else `selftest=false`. A PR that does neither
cannot change the walls or the top-level coverage the self-test checks.

`check` judges every path changed between <base-rev> and <head-rev> (both sides of a
rename, deletions included):
  1. ALLOWLIST: the path must be under one of ALLOWED_ROOTS (src/, packages/).
  2. FORBIDDEN: the path must match no glob of the BASE revision's
     .github/officer/forbidden-paths.txt (the grammar of the agent's push gate, ported:
     match_forbidden below).
  3. MODE: no symlink (120000) or gitlink (160000) may be added or changed to.
  4. REGRESSION TEST: at least one added or modified file is a test (TEST_GLOBS: a file
     whose name matches `*.test.*` or `*.spec.*`, and that is not under src/pages/ or
     src/app/, where every file is a route). Every officer PR must carry a regression
     test for the fault it fixes (operator decision 2026-11-09); a deleted test does not count.
  5. MONEY, AUTH AND GATING: a changed, added, deleted or renamed-away path that is not a test
     file must match no glob of the BASE revision's .github/officer/money-paths.txt (same
     grammar, but CASE-INSENSITIVE, so `*buzz*` matches BuzzButton.tsx). Its tests may change.
  6. NO DELETED TEST: no test file may be deleted (a rename is a deletion here).
  7. NO LOST ASSERTIONS: no modified test file may have fewer `expect(` calls at <head-rev>
     than at <base-rev>, counted per file (a gain in another file does not offset a loss).
  8. NO SKIPPED OR RE-TIMED TEST: no line an added or modified test file gains may carry a
     test-runner modifier (MODIFIER: `.skip`, `.only`, `.todo`, `.fails`, `skipIf`, `runIf`,
     `retry:`, `testTimeout`, `hookTimeout`, `timeout:`, or `}, <number>)`).
An empty diff FAILS: an officer PR always changes something, and "nothing changed" more
often means wrong revisions than a clean PR.

🔴 FAIL CLOSED: the lists and the logins are read from <base-rev> with `git show` and from
nowhere else. The workflow also runs THIS FILE from the base, never the PR's copy.

Exit status: 0 pass, 1 a check failed, 2 usage, environment or missing-input error.
Python 3 standard library only.
"""
import re
import subprocess
import sys

LIST = ".github/officer/forbidden-paths.txt"
MONEY = ".github/officer/money-paths.txt"
LOGINS = ".github/officer/bot-logins.txt"
ALLOWED_ROOTS = ("src/", "packages/")
BRANCH_PREFIX = "officer/"
BASE_REF = "main"
SELFTEST_DIR = ".github/officer/"
BAD_MODES = {"120000": "a symlink", "160000": "a submodule gitlink"}
TEST_GLOBS = ("*.test.*", "*.spec.*")
# Next.js route roots: every file under them is a route or API handler whatever its name
# (no `pageExtensions` narrows that), so a `*.test.ts` there is application code, never a test.
ROUTE_ROOTS = ("src/pages/", "src/app/")
EXPECT = "expect("
# A test-runner modifier on an ADDED line of a test file: skip/focus/todo/expected-failure
# (`.skip`, `.only`, `.todo`, `.fails`, also as `.skip.each` and the like), conditional runs
# (`skipIf`, `runIf`), retries, and timeout overrides (`testTimeout`, `hookTimeout`,
# `timeout:` options, or a numeric argument right after a callback's closing brace, as in
# `}, 30000)`). Each lets a test stop failing without its assertions changing. Removing one
# only makes more tests run, so removed lines are not judged.
MODIFIER = re.compile(r"\.(?:skip|only|todo|fails)\b|\b(?:skipIf|runIf|testTimeout|hookTimeout)\b"
                      r"|\bretry\s*:|\btimeout\s*:|^\s*\}\s*,\s*[0-9][0-9_]*\s*\)")
NOREPLY = re.compile(r"^(?:[0-9]+\+)?(?P<login>[^@]+)@users\.noreply\.github\.com$", re.IGNORECASE)


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


def compile_glob(pat, flags=0):
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
    return re.compile("".join(out), re.DOTALL | flags)


def match_forbidden(pat, path):
    """Does `path` match `pat`? A pattern with no '/' is tried against every segment."""
    try:
        rx = compile_glob(pat)
    except ValueError:
        return True  # a broken brick is not a gap
    if "/" not in pat:
        return any(rx.fullmatch(seg) for seg in path.split("/"))
    return bool(rx.fullmatch(path))


def money_hit(globs, path):
    """The first money-paths glob `path` matches, case-insensitively, else None. Same segment
    rule as match_forbidden: a pattern with no '/' is tried against every segment."""
    for pat in globs:
        rx = compile_glob(pat, re.IGNORECASE)
        if "/" in pat:
            if rx.fullmatch(path):
                return pat
        elif any(rx.fullmatch(seg) for seg in path.split("/")):
            return pat
    return None


def parse_list(content, name=LIST):
    """One glob per line; blank and `#` lines skipped. Any invalid line is an error."""
    out = []
    for n, line in enumerate(content.replace("\r\n", "\n").split("\n"), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            compile_glob(line)
        except ValueError as e:
            raise Fatal(f"{name} line {n} {line!r}: {e}")
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


def is_test(path):
    """A test file: its NAME (the last segment) matches a TEST_GLOBS pattern, and it is not
    under a ROUTE_ROOTS directory (where any file is served as a route)."""
    if path.startswith(ROUTE_ROOTS):
        return False
    name = path.rsplit("/", 1)[-1]
    return any(compile_glob(g).fullmatch(name) for g in TEST_GLOBS)


def expect_count(rev, path):
    return git("show", f"{rev}:{path}").decode("utf-8", errors="replace").count(EXPECT)


def added_modifiers(base, head, path):
    """[(line, text)] for each line `path` gains between base and head that matches MODIFIER."""
    raw = git("diff", "-U0", "--no-renames", "--no-color", base, head, "--", path).decode("utf-8", errors="replace")
    out, n = [], None   # None until the first hunk: `+++ b/<path>` is a header, not a line
    for line in raw.split("\n"):
        m = re.match(r"^@@ -[0-9,]+ \+([0-9]+)", line)
        if m:
            n = int(m.group(1))
            continue
        if n is not None and line.startswith("+"):
            if MODIFIER.search(line[1:]):
                out.append((n, line[1:].strip()))
            n += 1
    return out


def read_logins(base):
    out = set()
    for line in from_base(base, LOGINS).replace("\r", "").split("\n"):
        line = "".join(line.split("#", 1)[0].split())
        if line:
            out.add(line.lower())
    return out


def range_identities(base, head):
    """[(sha, role, name, email)] for the author and committer of every commit in base..head.

    Fail closed when a shallow boundary falls inside the range: git would stop walking there
    and report fewer commits than the PR has, with no error."""
    raw = git("log", "-z", "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce", f"{base}..{head}")
    commits = [r.split(b"\x1f") for r in raw.split(b"\0") if r.strip()]
    shallow = git("rev-parse", "--is-shallow-repository").decode().strip() == "true"
    if shallow:
        path = git("rev-parse", "--git-path", "shallow").decode().strip()
        try:
            with open(path) as f:
                cut = {ln.strip() for ln in f if ln.strip()}
        except OSError:
            cut = set()
        hit = [c[0].decode().strip() for c in commits if c[0].decode().strip() in cut]
        if hit:
            raise Fatal(f"the history is shallow and cut at {hit[0][:12]}, inside {base}..{head}; "
                        "cannot see every commit to arm on (fail closed; fetch the full PR history)")
    out = []
    for c in commits:
        sha, an, ae, cn, ce = (x.decode("utf-8", errors="replace").strip() for x in c)
        out.append((sha, "author", an, ae))
        out.append((sha, "committer", cn, ce))
    return out


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
def arm_reason(base, head, ref, author, sender):
    """Why the PR is armed, or None."""
    if ref.startswith(BRANCH_PREFIX):
        return f"{BRANCH_PREFIX} head ref {ref}"
    base_c, head_c = resolve(base), resolve(head)
    logins = read_logins(base_c)
    if author.lower() in logins:
        return f"officer bot author {author}"
    if sender.lower() in logins:
        return f"officer bot sender {sender}"
    for sha, role, name, email in range_identities(base_c, head_c):
        m = NOREPLY.match(email)
        for who in (name, m.group("login") if m else None):
            if who and who.lower() in logins:
                return f"commit {sha[:12]} has officer bot {who} as its {role}"
    return None


def cmd_arm(base, head, base_ref, ref, author, sender):
    if not all((base, head, base_ref, ref, author, sender)):
        raise Fatal("an empty argument; cannot decide whether the officer check applies (fail closed)")
    why = arm_reason(base, head, ref, author, sender)
    if why is None:
        print("armed=false")
        print(f"why: head ref is not {BRANCH_PREFIX}*, and neither the author {author}, the sender {sender} "
              f"nor any commit's author or committer is a listed officer bot")
        return 0
    print("armed=true")
    print(f"why: {why}")
    if base_ref != BASE_REF:
        print(f"FAIL: an officer PR must target {BASE_REF}, not {base_ref!r} "
              f"(the walls are judged against {BASE_REF}'s list)")
        return 1
    return 0


def cmd_selftest_needed(base, rev):
    base_c, rev_c = resolve(base), resolve(rev)
    touched = [p for _, _, _, p in changed_entries(base_c, rev_c) if p.startswith(SELFTEST_DIR)]
    if touched:
        print("selftest=true")
        print(f"why: touches {SELFTEST_DIR}, e.g. {touched[0]!r}")
        return 0
    def top(r):
        return {n for n in git("ls-tree", "-z", "--name-only", r).decode("utf-8", errors="surrogateescape").split("\0") if n}
    added = sorted(top(rev_c) - top(base_c))
    if added:
        print("selftest=true")
        print(f"why: adds top-level {', '.join(repr(a) for a in added)} (forbidden-paths.txt must list it)")
        return 0
    print("selftest=false")
    print(f"why: touches nothing under {SELFTEST_DIR} and adds no top-level entry")
    return 0


def cmd_check(base, head):
    base_c, head_c = resolve(base), resolve(head)
    globs = parse_list(from_base(base_c, LIST))
    if not globs:
        raise Fatal(f"{LIST} on {base} holds no patterns")
    money = parse_list(from_base(base_c, MONEY), MONEY)
    if not money:
        raise Fatal(f"{MONEY} on {base} holds no patterns")
    entries = changed_entries(base_c, head_c)
    print(f"== officer PR check: {len(entries)} changed path(s), base {base_c[:12]}, head {head_c[:12]}, "
          f"{len(globs)} forbidden pattern(s) from the base, allowed roots {', '.join(ALLOWED_ROOTS)}")
    if not entries:
        print("FAIL: no changed paths between base and head. Wrong revisions?")
        return 1
    violations, tests, deleted_tests, lost, modified = [], [], [], [], []
    for old_mode, new_mode, status, path in entries:
        if is_test(path):
            if status == "D":
                deleted_tests.append(path)
            else:
                tests.append(path)
                if status != "A":
                    before, after = expect_count(base_c, path), expect_count(head_c, path)
                    if after < before:
                        lost.append(f"  {path!r}: {before} -> {after}")
                if new_mode not in BAD_MODES:
                    modified += [f"  {path!r} line {n}: {text}" for n, text in added_modifiers(base_c, head_c, path)]
        why = []
        if not path.startswith(ALLOWED_ROOTS):
            why.append("outside the allowed roots")
        hit = next((g for g in globs if match_forbidden(g, path)), None)
        if hit:
            why.append(f"matches forbidden pattern {hit}")
        mhit = None if is_test(path) else money_hit(money, path)
        if mhit:
            why.append(f"is money, auth or gating code (matches {mhit} in {MONEY}); only its tests may change")
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
              f"(a file named like one of {', '.join(TEST_GLOBS)})")
        rc = 1
    if deleted_tests:
        print(f"FAIL: {len(deleted_tests)} test file(s) deleted; an officer PR may not delete a test:")
        print("\n".join(f"  {p!r}" for p in deleted_tests))
        rc = 1
    if lost:
        print(f"FAIL: {len(lost)} test file(s) lose {EXPECT} calls; an officer PR may not weaken a test:")
        print("\n".join(lost))
        rc = 1
    if modified:
        print(f"FAIL: {len(modified)} added test line(s) skip, focus, retry or re-time a test; "
              "an officer PR may not weaken a test:")
        print("\n".join(modified))
        rc = 1
    return rc


def main(argv):
    try:
        if len(argv) == 8 and argv[1] == "arm":
            return cmd_arm(*argv[2:8])
        if len(argv) == 4 and argv[1] == "selftest-needed":
            return cmd_selftest_needed(argv[2], argv[3])
        if len(argv) == 4 and argv[1] == "check":
            return cmd_check(argv[2], argv[3])
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    except Fatal as e:
        print(f"FATAL: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
