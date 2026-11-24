#!/usr/bin/env python3
"""Self-test for officer_pr_check.py and the REAL forbidden-paths.txt / bot-logins.txt.

Run: python3 .github/officer/test_officer_pr_check.py   (standard library + git only)

Three groups:
  * GlobGrammar: the ported push-gate grammar, pinned on literal cases.
  * Fixture: throwaway git repos in a temp dir; the checker runs as CI runs it
    (`check <base> <head>`, `arm <base> <ref> <author>`), and each wall must go RED on the
    change it exists to catch, with its own reason (a head adds a regression test unless
    the test is about that rule, so a refusal is never check 4's by accident).
  * RealList: the committed list parses, forbids each class the policy names and every
    entry of the ci-watch officer charter's floor (CHARTER_FLOOR), leaves ordinary
    application code alone, and forbids EVERY top-level entry of this checkout
    except src/ and packages/ (the agent's push gate has no allowlist, so the list must
    spell it out; a new top-level entry fails here until it is listed).
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import officer_pr_check as opc  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
CHECKER = os.path.join(HERE, "officer_pr_check.py")
REAL_LIST = os.path.join(HERE, "forbidden-paths.txt")
REAL_MONEY = os.path.join(HERE, "money-paths.txt")


class GlobGrammar(unittest.TestCase):
    def test_cases(self):
        cases = [
            # (pattern, path, matches)
            ("package.json", "package.json", True),
            ("package.json", "packages/civitai-ui/package.json", True),   # no '/': any segment
            ("package.json", "src/package.json.ts", False),
            ("*.prisma", "packages/x/prisma/schema.prisma", True),
            ("prisma/", "prisma/schema.prisma", True),
            ("prisma/", "src/shared/utils/prisma/enums.ts", False),          # '/': anchored at root
            ("**/migrations/**", "src/server/clickhouse/migrations/a.sql", True),
            ("**/migrations/**", "migrations/a.sql", True),
            ("**/migrations/**", "src/server/migrations.ts", False),
            (".env*", "src/.env.local", True),
            (".env*", "src/environment.ts", False),
            ("Dockerfile*", "packages/x/Dockerfile.dev", True),
            ("docker-compose*", "docker-compose.yml", True),
            ("{a,b}.txt", "x/b.txt", True),
            ("{a,b}.txt", "x/c.txt", False),
            ("src/?.ts", "src/a.ts", True),
            ("src/?.ts", "src/ab.ts", False),
            ("apps/", "apps/x/y.ts", True),
            ("apps/", "src/apps/y.ts", False),
            ("apps/", "apps", False),                                       # dir/ needs something under it
            ("scripts", "packages/civitai-ui/scripts/add.mjs", True),
            ("src/*", "src/a/b.ts", False),                                  # '*' never crosses '/'
        ]
        for pat, path, want in cases:
            with self.subTest(pat=pat, path=path):
                self.assertEqual(opc.match_forbidden(pat, path), want)

    def test_refused_patterns(self):
        for bad in ["", "/abs", "a[bc]", "a\\b", "a//b", "./a", "a/../b", "a**b", "{a", "a}", "{}", "{a,}"]:
            with self.subTest(bad=bad):
                self.assertRaises(ValueError, opc.compile_glob, bad)
        # A pattern that does not compile matches everything (a broken brick is not a gap).
        self.assertTrue(opc.match_forbidden("a[b", "src/x.ts"))

    def test_is_test(self):
        for path, want in [("src/a.test.ts", True), ("packages/x/src/b.spec.tsx", True),
                           ("src/__tests__/pages/x.test.tsx", True), ("src/a.ts", False),
                           ("src/pages/api/x.test.ts", False), ("src/pages/x.spec.tsx", False),
                           ("src/app/route.test.ts", False)]:
            with self.subTest(path=path):
                self.assertEqual(opc.is_test(path), want)

    def test_parse_list_refuses_a_bad_line(self):
        self.assertEqual(opc.parse_list("# c\n\n  a/  \r\nb\n"), ["a/", "b"])
        with self.assertRaises(opc.Fatal):
            opc.parse_list("ok\nbad[x]\n")


class Fixture(unittest.TestCase):
    LIST = "package.json\npnpm-lock.yaml\npackages/civitai-db-schema/prisma/\n**/migrations/**\n.github\n.env*\nDockerfile*\nscripts\n"
    MONEY = "# money\n*buzz*\n*stripe*\n"

    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="officer-pr-check-")
        self.g("init", "-q", "-b", "main")
        self.write(".github/officer/forbidden-paths.txt", self.LIST)
        self.write(".github/officer/money-paths.txt", self.MONEY)
        self.write("src/server/services/buzz.service.ts", "export const buzz = 1;\n")
        self.write("src/components/BuzzButton.test.tsx", "expect(1).toBe(1);\n")
        self.write(".github/officer/bot-logins.txt", "# bots\n# placeholder[bot]\nCivitai-Officer-X[bot]   # x\r\n")
        self.write("src/app.ts", "export const a = 1;\n")
        self.write("src/old/keep.ts", "x\n")
        self.write("src/old/keep.test.ts", "expect(1).toBe(1);\nexpect(2).toBe(2);\n")
        self.write("packages/civitai-ui/src/b.ts", "export const b = 1;\n")
        self.write("packages/civitai-db-schema/prisma/schema.prisma", "model A {}\n")
        self.write("package.json", "{}\n")
        self.write("README.md", "r\n")
        self.g("add", ".")
        self.g("commit", "-q", "-m", "base")
        self.g("branch", "base")
        self.g("checkout", "-q", "-b", "officer/release-followup/1-fix")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def g(self, *args):
        subprocess.run(["git", "-C", self.d, "-c", "user.name=t", "-c", "user.email=t@t",
                        "-c", "commit.gpgsign=false", *args], check=True, capture_output=True)

    def write(self, rel, content):
        p = os.path.join(self.d, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(content)

    def commit(self, with_test=True):
        # By default the head also adds a regression test, so a refusal is attributable to
        # the path under test and not to check 4.
        if with_test:
            self.write("src/app.test.ts", "test('regression', () => {});\n")
        self.g("add", "-A")
        self.g("commit", "-q", "--allow-empty", "-m", "head")

    def run_checker(self, *args):
        r = subprocess.run([sys.executable, CHECKER, *args], cwd=self.d, capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

    def check(self):
        return self.run_checker("check", "base", "HEAD")

    def test_application_code_passes(self):
        self.write("src/app.ts", "export const a = 2;\n")
        self.write("packages/civitai-ui/src/c.ts", "export const c = 1;\n")
        self.commit()
        rc, out = self.check()
        self.assertEqual(rc, 0, out)
        self.assertIn("3 changed path(s)", out)
        self.assertIn("1 test file(s) added or modified", out)

    def test_no_regression_test_fails(self):
        self.write("src/app.ts", "export const a = 2;\n")
        self.commit(with_test=False)
        rc, out = self.check()
        self.assertEqual(rc, 1, out)
        self.assertIn("ok: every changed path is application code", out)
        self.assertIn("FAIL: no test file added or modified", out)

    def test_a_deleted_test_does_not_count(self):
        self.write("src/app.ts", "export const a = 2;\n")
        self.g("rm", "-q", "src/old/keep.test.ts")
        self.commit(with_test=False)
        rc, out = self.check()
        self.assertEqual(rc, 1, out)
        self.assertIn("FAIL: no test file added or modified", out)
        self.assertIn("FAIL: 1 test file(s) deleted", out)

    def test_a_non_test_file_under___tests___does_not_count(self):
        # Only *.test.* and *.spec.* count: a helper under __tests__/ is not a regression test.
        self.write("packages/civitai-ui/src/__tests__/helpers.ts", "export const h = 1;\n")
        self.write("packages/civitai-ui/src/b.ts", "export const b = 2;\n")
        self.commit(with_test=False)
        rc, out = self.check()
        self.assertEqual(rc, 1, out)
        self.assertIn("FAIL: no test file added or modified", out)

    def test_a_spec_file_counts(self):
        self.write("packages/civitai-ui/src/b.spec.tsx", "expect(1).toBe(1);\n")
        self.write("packages/civitai-ui/src/b.ts", "export const b = 2;\n")
        self.commit(with_test=False)
        rc, out = self.check()
        self.assertEqual(rc, 0, out)
        self.assertIn("1 test file(s) added or modified", out)

    def test_deleting_a_test_file_fails_even_with_a_new_test(self):
        self.g("rm", "-q", "src/old/keep.test.ts")
        self.commit()   # adds src/app.test.ts, so check 4 alone would pass
        rc, out = self.check()
        self.assertEqual(rc, 1, out)
        self.assertIn("FAIL: 1 test file(s) deleted", out)
        self.assertIn("'src/old/keep.test.ts'", out)
        self.assertIn("1 test file(s) added or modified", out)

    def test_a_net_loss_of_expect_calls_in_a_test_file_fails(self):
        self.write("src/old/keep.test.ts", "expect(1).toBe(1);\n// expect gone\n")
        self.write("src/old/keep.ts", "y\n")
        self.commit(with_test=False)
        rc, out = self.check()
        self.assertEqual(rc, 1, out)
        self.assertIn("FAIL: 1 test file(s) lose expect( calls", out)
        self.assertIn("'src/old/keep.test.ts': 2 -> 1", out)

    def test_moving_expect_calls_between_test_files_still_fails_the_one_that_lost_them(self):
        # Per file, as the charter says ("in a test file"): a gain elsewhere does not offset it.
        self.write("src/old/keep.test.ts", "expect(1).toBe(1);\n")
        self.write("src/app.test.ts", "expect(1).toBe(1);\nexpect(2).toBe(2);\nexpect(3).toBe(3);\n")
        self.g("add", "-A")
        self.g("commit", "-q", "-m", "head")
        rc, out = self.check()
        self.assertEqual(rc, 1, out)
        self.assertIn("'src/old/keep.test.ts': 2 -> 1", out)

    # ── check 8: no added skip, focus, retry or timeout modifier in a test file ──
    MODIFIER_LINES = ["describe.skip('a', () => {});", "it.only('b', () => {});", "test.todo('c');",
                      "test.fails('d', () => {});", "it.skip.each([1])('e', () => {});",
                      "test.skipIf(process.env.CI)('f', () => {});", "describe.runIf(false)('g', () => {});",
                      "test('h', { retry: 3 }, () => {});", "vi.setConfig({ testTimeout: 60000 });",
                      "test('i', { timeout: 60000 }, () => {});", "}, 30_000);", "vi.setConfig({ hookTimeout: 1 });"]

    def test_an_added_test_modifier_in_a_modified_test_file_fails(self):
        self.write("src/old/keep.test.ts", "expect(1).toBe(1);\nexpect(2).toBe(2);\n" + "\n".join(self.MODIFIER_LINES) + "\n")
        self.write("src/old/keep.ts", "y\n")
        self.commit(with_test=False)
        rc, out = self.check()
        self.assertEqual(rc, 1, out)
        self.assertIn(f"FAIL: {len(self.MODIFIER_LINES)} added test line(s) skip, focus, retry or re-time a test", out)
        for i, text in enumerate(self.MODIFIER_LINES):
            with self.subTest(line=text):
                self.assertIn(f"'src/old/keep.test.ts' line {i + 3}: {text}", out)

    def test_an_added_test_modifier_in_a_new_test_file_fails(self):
        self.write("src/app.ts", "export const a = 2;\n")
        self.write("src/new.test.ts", "it('x', () => { expect(1).toBe(1); });\nit.skip('y', () => {});\n")
        self.commit(with_test=False)
        rc, out = self.check()
        self.assertEqual(rc, 1, out)
        self.assertIn("'src/new.test.ts' line 2: it.skip('y', () => {});", out)

    def test_removing_a_test_modifier_and_ordinary_test_code_pass(self):
        # Control: un-skipping a test only makes more run, and ordinary lines (a retry helper,
        # a timeout constant, a call ending in a number) are not modifiers.
        self.g("checkout", "-q", "--detach", "base")
        self.write("src/old/keep.test.ts", "expect(1).toBe(1);\nexpect(2).toBe(2);\nit.skip('z', () => {});\n")
        self.g("commit", "-q", "-am", "skipped test on base")
        self.g("branch", "-f", "base", "HEAD")
        self.g("checkout", "-q", "-b", "officer/x/6-y")
        self.write("src/old/keep.test.ts", "expect(1).toBe(1);\nexpect(2).toBe(2);\nit('z', () => {});\n"
                   "const r = withRetry(fn);\nconst DEFAULT_TIMEOUT = 5;\nadd(1, 2);\n++n;\n")
        self.commit(with_test=False)
        rc, out = self.check()
        self.assertEqual(rc, 0, out)

    # ── a `*.test.*` name under a Next.js route root is a route, not a test ──
    def test_a_test_named_file_under_src_pages_is_not_a_test(self):
        self.write("src/pages/api/x.test.ts", "export default function h() {}\n")
        self.commit(with_test=False)
        rc, out = self.check()
        self.assertEqual(rc, 1, out)
        self.assertIn("FAIL: no test file added or modified", out)

    def test_a_test_named_money_route_under_src_pages_is_money_code(self):
        self.write("src/pages/api/buzz.test.ts", "export default function h() {}\n")
        self.commit()
        self.assert_refused("src/pages/api/buzz.test.ts", self.MONEY_WHY + " *buzz*")

    def test_adding_expect_calls_to_a_test_file_passes(self):
        self.write("src/old/keep.test.ts", "expect(1).toBe(1);\nexpect(2).toBe(2);\nexpect(3).toBe(3);\n")
        self.write("src/old/keep.ts", "y\n")
        self.commit(with_test=False)
        rc, out = self.check()
        self.assertEqual(rc, 0, out)
        self.assertIn("1 test file(s) added or modified", out)

    def assert_refused(self, path, reason):
        rc, out = self.check()
        self.assertEqual(rc, 1, out)
        self.assertIn(repr(path), out)
        self.assertIn(reason, out)

    def test_outside_allowed_roots_fails_even_when_unlisted(self):
        self.write("src/app.ts", "export const a = 2;\n")
        self.write("README.md", "changed\n")   # README.md is NOT in this fixture's list
        self.commit()
        self.assert_refused("README.md", "outside the allowed roots")

    def test_lockfile_fails(self):
        self.write("pnpm-lock.yaml", "lock\n")
        self.commit()
        self.assert_refused("pnpm-lock.yaml", "matches forbidden pattern pnpm-lock.yaml")

    def test_package_manifest_inside_packages_fails(self):
        self.write("packages/civitai-ui/package.json", "{}\n")
        self.commit()
        self.assert_refused("packages/civitai-ui/package.json", "matches forbidden pattern package.json")

    def test_prisma_schema_fails(self):
        self.write("packages/civitai-db-schema/prisma/schema.prisma", "model B {}\n")
        self.commit()
        self.assert_refused("packages/civitai-db-schema/prisma/schema.prisma",
                            "matches forbidden pattern packages/civitai-db-schema/prisma/")

    def test_migration_under_src_fails(self):
        self.write("src/server/clickhouse/migrations/2026-01-01-x.sql", "select 1;\n")
        self.commit()
        self.assert_refused("src/server/clickhouse/migrations/2026-01-01-x.sql", "matches forbidden pattern **/migrations/**")

    def test_workflow_change_fails(self):
        self.write(".github/workflows/x.yml", "on: push\n")
        self.commit()
        self.assert_refused(".github/workflows/x.yml", "matches forbidden pattern .github")

    def test_env_file_inside_src_fails(self):
        self.write("src/.env.local", "A=1\n")
        self.commit()
        self.assert_refused("src/.env.local", "matches forbidden pattern .env*")

    def test_dockerfile_inside_packages_fails(self):
        self.write("packages/civitai-ui/Dockerfile", "FROM x\n")
        self.commit()
        self.assert_refused("packages/civitai-ui/Dockerfile", "matches forbidden pattern Dockerfile*")

    def test_rename_out_of_a_forbidden_path_is_caught_by_its_old_path(self):
        self.g("mv", "packages/civitai-db-schema/prisma/schema.prisma", "src/schema.txt")
        self.commit()
        rc, out = self.check()
        self.assertEqual(rc, 1, out)
        self.assertIn("'packages/civitai-db-schema/prisma/schema.prisma' [D]", out)
        self.assertIn("1 test file(s) added or modified", out)

    def test_deleting_a_forbidden_file_fails(self):
        self.g("rm", "-q", "package.json")
        self.commit()
        self.assert_refused("package.json", "matches forbidden pattern package.json")

    # ── money, auth and gating code: tests only ──
    MONEY_WHY = "is money, auth or gating code (matches"

    def test_a_non_test_money_change_fails_at_every_depth_case_insensitively(self):
        paths = ["src/components/BuzzButton.tsx",                   # case-insensitive, file name
                 "src/server/services/buzz/x.ts",                   # a directory segment
                 "packages/civitai-ui/src/a/b/c/Stripe-Checkout.ts"]  # deep, in a package
        for p in paths:
            self.write(p, "export const x = 1;\n")
        self.commit()
        rc, out = self.check()
        self.assertEqual(rc, 1, out)
        for p in paths:
            with self.subTest(path=p):
                self.assertIn(f"{p!r} [A]: {self.MONEY_WHY}", out)

    def test_a_money_test_file_is_allowed(self):
        self.write("src/components/BuzzButton.test.tsx", "expect(1).toBe(1);\nexpect(2).toBe(2);\n")
        self.write("src/server/services/buzz.spec.ts", "expect(1).toBe(1);\n")
        self.commit(with_test=False)
        rc, out = self.check()
        self.assertEqual(rc, 0, out)
        self.assertIn("2 test file(s) added or modified", out)

    def test_modifying_a_money_file_fails(self):
        self.write("src/server/services/buzz.service.ts", "export const buzz = 2;\n")
        self.commit()
        self.assert_refused("src/server/services/buzz.service.ts", self.MONEY_WHY + " *buzz*")

    def test_deleting_or_renaming_away_a_money_file_fails(self):
        self.g("mv", "src/server/services/buzz.service.ts", "src/server/services/tokens.service.ts")
        self.commit()
        self.assert_refused("src/server/services/buzz.service.ts", self.MONEY_WHY)
        self.assertIn("'src/server/services/buzz.service.ts' [D]", self.check()[1])

    def test_the_base_money_list_is_used_not_the_prs(self):
        self.write(".github/officer/money-paths.txt", "# nothing\n")
        self.write("src/components/BuzzButton.tsx", "export const x = 1;\n")
        self.commit()
        self.assert_refused("src/components/BuzzButton.tsx", self.MONEY_WHY)

    def test_fail_closed_when_the_base_lacks_the_money_list(self):
        self.g("checkout", "-q", "--detach", "base")
        self.g("rm", "-q", ".github/officer/money-paths.txt")
        self.g("commit", "-q", "-m", "no money list")
        self.g("branch", "-f", "base", "HEAD")
        self.g("checkout", "-q", "-b", "officer/x/4-y")
        self.write("src/app.ts", "export const a = 3;\n")
        self.commit()
        rc, out = self.check()
        self.assertEqual(rc, 2, out)
        self.assertIn("money-paths.txt is not on the base revision", out)

    def test_fail_closed_on_an_empty_base_money_list(self):
        self.g("checkout", "-q", "--detach", "base")
        self.write(".github/officer/money-paths.txt", "# every pattern removed\n\n")
        self.g("commit", "-q", "-am", "empty money list")
        self.g("branch", "-f", "base", "HEAD")
        self.g("checkout", "-q", "-b", "officer/x/5-y")
        self.write("src/components/BuzzButton.tsx", "export const x = 1;\n")
        self.commit()
        rc, out = self.check()
        self.assertEqual(rc, 2, out)
        self.assertIn("money-paths.txt on base holds no patterns", out)

    def test_symlink_in_src_fails(self):
        os.symlink("../.github/officer/forbidden-paths.txt", os.path.join(self.d, "src/link.ts"))
        self.commit()
        self.assert_refused("src/link.ts", "is a symlink")

    def test_non_ascii_path_is_checked_as_the_real_path(self):
        self.write("src/é/.env", "A=1\n")
        self.commit()
        self.assert_refused("src/é/.env", "matches forbidden pattern .env*")

    def test_empty_diff_fails(self):
        self.commit(with_test=False)
        rc, out = self.check()
        self.assertEqual(rc, 1, out)
        self.assertIn("no changed paths", out)

    def test_the_base_list_is_used_not_the_prs(self):
        # The PR empties the list in the same change that touches a lockfile.
        self.write(".github/officer/forbidden-paths.txt", "# nothing\nnever-matches-anything\n")
        self.write("src/pnpm-lock.yaml", "lock\n")
        self.commit()
        self.assert_refused("src/pnpm-lock.yaml", "matches forbidden pattern pnpm-lock.yaml")

    def test_fail_closed_when_the_base_lacks_the_list(self):
        self.g("checkout", "-q", "--detach", "base")
        self.g("rm", "-q", ".github/officer/forbidden-paths.txt")
        self.g("commit", "-q", "-m", "no list")
        self.g("branch", "-f", "base", "HEAD")
        self.g("checkout", "-q", "-b", "officer/x/2-y")
        self.write("src/app.ts", "export const a = 3;\n")
        self.commit()
        rc, out = self.check()
        self.assertEqual(rc, 2, out)
        self.assertIn("not on the base revision", out)

    def test_fail_closed_on_an_unparsable_base_list(self):
        self.g("checkout", "-q", "--detach", "base")
        self.write(".github/officer/forbidden-paths.txt", "src/[ab].ts\n")
        self.g("commit", "-q", "-am", "bad list")
        self.g("branch", "-f", "base", "HEAD")
        self.g("checkout", "-q", "-b", "officer/x/3-y")
        self.write("src/app.ts", "export const a = 3;\n")
        self.commit()
        rc, out = self.check()
        self.assertEqual(rc, 2, out)
        self.assertIn("line 1", out)

    # ── arm ──
    def arm(self, ref, author, sender=None, base_ref="main", cwd=None):
        args = ["arm", "base", "HEAD", base_ref, ref, author, sender or author]
        if cwd is None:
            return self.run_checker(*args)
        r = subprocess.run([sys.executable, CHECKER, *args], cwd=cwd, capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

    def commit_as(self, author, committer=("t", "t@t")):
        self.n = getattr(self, "n", 0) + 1
        self.write("src/app.ts", "export const a = %d;\n" % (100 + self.n))
        self.g("add", "-A")
        env = dict(os.environ, GIT_AUTHOR_NAME=author[0], GIT_AUTHOR_EMAIL=author[1],
                   GIT_COMMITTER_NAME=committer[0], GIT_COMMITTER_EMAIL=committer[1])
        subprocess.run(["git", "-C", self.d, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "c"],
                       check=True, capture_output=True, env=env)

    def test_arm_officer_prefix(self):
        rc, out = self.arm("officer/release-followup/12-fix", "SomeHuman")
        self.assertEqual(rc, 0, out)
        self.assertIn("armed=true", out)

    def test_arm_listed_bot_on_any_branch_case_insensitive_crlf(self):
        rc, out = self.arm("fix/oom", "civitai-officer-x[bot]")
        self.assertEqual(rc, 0, out)
        self.assertIn("armed=true", out)
        self.assertIn("officer bot author", out)

    def test_arm_listed_bot_sender(self):
        # A human-authored PR that a listed bot pushed to (the event's sender) is armed.
        rc, out = self.arm("fix/oom", "SomeHuman", sender="CIVITAI-OFFICER-X[bot]")
        self.assertEqual(rc, 0, out)
        self.assertIn("armed=true", out)
        self.assertIn("officer bot sender", out)

    def test_arm_a_commit_authored_by_a_listed_bot(self):
        self.g("checkout", "-q", "-b", "fix/oom")
        self.commit_as(("t", "t@t"))
        self.commit_as(("civitai-officer-x[bot]", "1+civitai-officer-x[bot]@users.noreply.github.com"))
        rc, out = self.arm("fix/oom", "SomeHuman")
        self.assertEqual(rc, 0, out)
        self.assertIn("armed=true", out)
        self.assertIn("author", out)
        self.assertIn("commit", out)

    def test_arm_a_commit_committed_by_a_listed_bot_by_email_only(self):
        self.g("checkout", "-q", "-b", "fix/oom")
        self.commit_as(("SomeHuman", "h@h"), committer=("A Name", "42+Civitai-Officer-X[bot]@users.noreply.github.com"))
        rc, out = self.arm("fix/oom", "SomeHuman")
        self.assertEqual(rc, 0, out)
        self.assertIn("armed=true", out)
        self.assertIn("committer", out)

    def test_human_commits_do_not_arm(self):
        self.g("checkout", "-q", "-b", "fix/oom")
        self.commit_as(("SomeHuman", "h@h"), committer=("placeholder[bot]", "placeholder[bot]@x"))
        self.commit_as(("civitai-officer-x", "civitai-officer-x@users.noreply.github.com"))
        rc, out = self.arm("fix/oom", "SomeHuman")
        self.assertEqual(rc, 0, out)
        self.assertIn("armed=false", out)

    def test_arm_fails_closed_on_truncated_history(self):
        # A shallow checkout that cuts the base..head range cannot prove no bot commit is in it.
        self.g("checkout", "-q", "-b", "fix/oom")
        self.commit_as(("civitai-officer-x[bot]", "x@x"))
        self.commit_as(("SomeHuman", "h@h"))
        clone = tempfile.mkdtemp(prefix="officer-pr-check-shallow-")
        self.addCleanup(shutil.rmtree, clone, True)
        subprocess.run(["git", "clone", "-q", "--depth", "1", "--branch", "fix/oom", "file://" + self.d, clone],
                       check=True, capture_output=True)
        subprocess.run(["git", "-C", clone, "fetch", "-q", "--depth", "1", "origin", "base:base"],
                       check=True, capture_output=True)
        rc, out = self.arm("fix/oom", "SomeHuman", cwd=clone)
        self.assertEqual(rc, 2, out)
        self.assertIn("shallow", out)
        # Control: the full history arms on the bot commit.
        rc, out = self.arm("fix/oom", "SomeHuman")
        self.assertIn("armed=true", out)

    def test_armed_pr_against_a_base_other_than_main_fails(self):
        for ref, author in [("officer/x/1-y", "SomeHuman"), ("fix/oom", "civitai-officer-x[bot]")]:
            with self.subTest(ref=ref):
                rc, out = self.arm(ref, author, base_ref="feat/thing")
                self.assertEqual(rc, 1, out)
                self.assertIn("armed=true", out)
                self.assertIn("FAIL: an officer PR must target main", out)

    def test_unarmed_pr_against_another_base_passes(self):
        rc, out = self.arm("fix/oom", "SomeHuman", base_ref="feat/thing")
        self.assertEqual(rc, 0, out)
        self.assertIn("armed=false", out)

    def test_human_on_other_branch_not_armed(self):
        for ref, author in [("fix/oom", "SomeHuman"), ("officers/x", "a"), ("zach/officer/x", "a"),
                            ("Officer/x", "a"), ("fix/oom", "civitai-officer-x"), ("fix/oom", "placeholder[bot]"),
                            ("fix/oom", "#")]:
            with self.subTest(ref=ref, author=author):
                rc, out = self.arm(ref, author)
                self.assertEqual(rc, 0, out)
                self.assertIn("armed=false", out)

    def test_arm_reads_the_base_logins_not_the_working_tree(self):
        with open(os.path.join(self.d, ".github/officer/bot-logins.txt"), "a") as f:
            f.write("SomeHuman\n")
        rc, out = self.arm("fix/oom", "SomeHuman")
        self.assertIn("armed=false", out)

    def test_arm_fails_closed(self):
        self.assertEqual(self.arm("fix/oom", "")[0], 2)
        self.assertEqual(self.arm("", "SomeHuman")[0], 2)
        self.assertEqual(self.arm("fix/oom", "SomeHuman", base_ref="")[0], 2)
        self.g("checkout", "-q", "--detach", "base")
        self.g("rm", "-q", ".github/officer/bot-logins.txt")
        self.g("commit", "-q", "-m", "no logins")
        self.g("branch", "-f", "base", "HEAD")
        self.assertEqual(self.arm("fix/oom", "SomeHuman")[0], 2)
        # ...but an officer/ ref still arms without the list.
        self.assertIn("armed=true", self.arm("officer/x/1-y", "SomeHuman")[1])

    # ── selftest-needed (D1: the self-test runs only when it can say something new) ──
    def selftest_needed(self):
        return self.run_checker("selftest-needed", "base", "HEAD")

    def test_selftest_needed_when_the_officer_dir_changes(self):
        self.write(".github/officer/bot-logins.txt", "x[bot]\n")
        self.commit(with_test=False)
        rc, out = self.selftest_needed()
        self.assertEqual(rc, 0, out)
        self.assertIn("selftest=true", out)

    def test_selftest_needed_when_a_top_level_directory_is_added(self):
        self.write("newtool/x.txt", "x\n")
        self.commit(with_test=False)
        rc, out = self.selftest_needed()
        self.assertEqual(rc, 0, out)
        self.assertIn("selftest=true", out)
        self.assertIn("'newtool'", out)

    def test_selftest_needed_when_a_top_level_file_is_added(self):
        self.write("NEWFILE.md", "x\n")
        self.commit(with_test=False)
        rc, out = self.selftest_needed()
        self.assertEqual(rc, 0, out)
        self.assertIn("selftest=true", out)
        self.assertIn("'NEWFILE.md'", out)

    def test_selftest_not_needed_for_ordinary_changes(self):
        self.write("src/app.ts", "export const a = 9;\n")
        self.write("README.md", "changed\n")          # an existing top-level entry, modified
        self.write(".github/workflows/x.yml", "on: push\n")
        self.g("rm", "-q", "package.json")              # a top-level entry removed
        self.commit(with_test=False)
        rc, out = self.selftest_needed()
        self.assertEqual(rc, 0, out)
        self.assertIn("selftest=false", out)


class RealList(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(REAL_LIST) as f:
            cls.globs = opc.parse_list(f.read())

    def forbidden(self, path):
        return any(opc.match_forbidden(g, path) for g in self.globs)

    def test_forbids_every_policy_class(self):
        for p in ["pnpm-lock.yaml", "package.json", "packages/civitai-ui/package.json", "src/yarn.lock",
                  "packages/civitai-db-schema/prisma/schema.prisma", "prisma/migrations/x/migration.sql",
                  "src/server/clickhouse/migrations/2026-01-01-x.sql", "src/server/services/apps/migrations/1_x.sql",
                  ".github/workflows/x.yml", ".github/officer/forbidden-paths.txt", ".github/officer/bot-logins.txt",
                  ".github/officer/officer_pr_check.py", ".github/officer/money-paths.txt", "scripts/ci/x.mjs", "packages/civitai-ui/scripts/x.mjs",
                  ".env", ".env.production", "src/.env.local", "Dockerfile", "packages/x/Dockerfile.dev",
                  "docker-compose.yml", ".husky/pre-commit", "CLAUDE.md", "src/AGENTS.md", ".gitattributes",
                  "src/x/.gitattributes", "event-engine-common", "apps/moderator/src/x.ts",
                  # the unit suite's global setup (vitest.config.mts `setupFiles`), and future ones there
                  "src/__tests__/setup.ts", "src/__tests__/network-guard.ts", "src/__tests__/global-setup.ts",
                  "src/__tests__/setup-env.mts"]:
            with self.subTest(path=p):
                self.assertTrue(self.forbidden(p), f"{p} is not forbidden by {REAL_LIST}")

    # The ci-watch officer charter's floor: what it treats as forbidden until this list exists
    # on main. Pinned here entry by entry (with variants and depths) so the list cannot again
    # fall below it. A charter change that widens the floor must add its entries here too.
    CHARTER_FLOOR = {
        "Prisma schema and migrations": ["prisma/schema.prisma", "packages/civitai-db-schema/prisma/schema.full.prisma",
                                         "packages/civitai-db-schema/prisma/migrations/1_x/migration.sql",
                                         "src/server/clickhouse/migrations/x.sql"],
        ".github/": [".github/workflows/x.yml", ".github/officer/forbidden-paths.txt"],
        "scripts/": ["scripts/ci/x.mjs", "packages/civitai-ui/scripts/x.mjs"],
        "vitest.config.*": ["vitest.config.mts", "vitest.config.ts", "packages/civitai-ui/vitest.config.ts",
                            "packages/civitai-post-planner/vitest.browser.config.ts", "src/x/vitest.config.js",
                            "vitest.workspace.config.mjs"],
        "playwright*.config.ts": ["playwright.config.ts", "playwright.preview.config.ts",
                                  "packages/x/playwright.e2e.config.ts"],
        "*baseline*.json": ["scripts/ci/typecheck-tests-baseline.json",
                            "packages/civitai-db-schema/src/schema-drift/drift-baseline.json",
                            "src/x/baseline.json", "packages/x/perf.baseline.v2.json"],
        ".bundle-budget.json": [".bundle-budget.json", "packages/x/.bundle-budget.json"],
        ".claude/": [".claude/settings.json", ".claude/skills/x/SKILL.md"],
        "CLAUDE.md": ["CLAUDE.md", "src/CLAUDE.md", "packages/x/CLAUDE.md"],
        "AGENTS.md": ["AGENTS.md", "packages/x/AGENTS.md"],
        "opencode.json": ["opencode.json"],
        "package.json": ["package.json", "packages/civitai-ui/package.json"],
        "pnpm-lock.yaml": ["pnpm-lock.yaml", "packages/x/pnpm-lock.yaml"],
        "patches/": ["patches/x.patch"],
        ".npmrc": [".npmrc", "packages/x/.npmrc"],
        ".nvmrc": [".nvmrc", "src/.nvmrc"],
        "Dockerfile*": ["Dockerfile", "packages/x/Dockerfile.prod"],
        "docker-compose*": ["docker-compose.yml", "docker-compose.base.yml", "packages/x/docker-compose.dev.yaml"],
        "containers/": ["containers/x/y"],
        "ops/": ["ops/x/y.yaml"],
        "next.config.mjs": ["next.config.mjs", "packages/x/next.config.mjs"],
        "apps/": ["apps/moderator/src/x.ts", "apps/auth/package.json"],
        ".env*": [".env", ".env.production", "src/.env.local", ".envrc.example"],
        "src/env/": ["src/env/server.ts", "src/env/client.mjs", "src/env/__tests__/x.test.ts"],
        "src/proxy.ts": ["src/proxy.ts"],
        "src/server/middleware/": ["src/server/middleware/x.middleware.ts", "src/server/middleware/a/b.ts"],
        "packages/civitai-auth/": ["packages/civitai-auth/src/index.ts", "packages/civitai-auth/src/__tests__/x.test.ts"],
        ".eslintrc*": [".eslintrc.js", ".eslintrc", "packages/.eslintrc.cjs", "src/x/.eslintrc.json"],
    }

    def test_forbids_the_ci_watch_charter_floor(self):
        for entry, probes in self.CHARTER_FLOOR.items():
            for p in probes:
                with self.subTest(entry=entry, path=p):
                    self.assertTrue(self.forbidden(p), f"charter floor {entry!r}: {p} is not forbidden by {REAL_LIST}")

    # The charter's money, auth and gating sentence: `*buzz*`, `*stripe*`, `*paddle*`,
    # `*payment*` services and the hosted review gate's sensitive-path topics. Pinned whole, so a
    # dropped or added pattern is a visible change here.
    MONEY_PATTERNS = {"*auth*", "*session*", "*permission*", "*buzz*", "*payment*", "*stripe*", "*paddle*",
                      "*billing*", "*purchase*", "*payout*", "*withdraw*", "*subscription*", "*email*", "*pii*",
                      "*nsfw*", "*browsing-level*", "*browsinglevel*", "*moderat*",
                      "src/server/trpc.ts", "src/server/middleware.trpc.ts", "src/server/createContext.ts",
                      "src/server/utils/endpoint-helpers.ts", "*api-key*", "*apikey*", "*access-token*",
                      "*accesstoken*", "*revocation*", "*revoke-user-token*", "*coinbase*", "*tipalti*",
                      "*creator-program*", "*creatorprogram*", "*redeemable*", "*refund*",
                      "src/pages/api/v1/blocks/tip*", "src/server/**/*bount*", "src/server/**/*bount*/**",
                      "src/server/**/*vault*", "src/pages/api/**/*bount*", "src/pages/api/**/*bount*/**",
                      "src/pages/api/**/*vault*", "src/pages/api/**/*vault*/**", "packages/**/*bount*",
                      "src/pages/api/mod/*...path*", "src/pages/api/admin/*...path*",
                      "src/server/utils/api-router.ts", "src/server/utils/api-routes/**",
                      "*csam*", "*mod-gate*", "*ban-user*"}

    def test_the_money_list_is_the_charter_set(self):
        with open(REAL_MONEY) as f:
            self.assertEqual(set(opc.parse_list(f.read(), REAL_MONEY)), self.MONEY_PATTERNS)

    def test_the_money_list_matches_real_money_auth_and_gating_paths(self):
        with open(REAL_MONEY) as f:
            money = opc.parse_list(f.read(), REAL_MONEY)
        for p in ["src/components/BuzzButton.tsx", "src/server/services/buzz.service.ts",
                  "src/server/services/stripe.service.ts", "src/server/routers/paddle.router.ts",
                  "src/components/Account/UserPaymentConfigurationCard.tsx", "src/providers/SessionProvider.tsx",
                  "src/server/utils/browsingLevel.ts", "src/server/services/moderation/x.ts",
                  "src/server/services/subscriptions.service.ts", "src/server/email/templates/x.ts",
                  "src/components/BrowsingLevel/x.tsx", "src/server/services/nsfwLevels.ts",
                  # the request-auth core
                  "src/server/trpc.ts", "src/server/middleware.trpc.ts", "src/server/createContext.ts",
                  "src/server/utils/endpoint-helpers.ts",
                  # credentials and their revocation
                  "src/server/services/api-key.service.ts", "src/server/routers/apiKey.router.ts",
                  "src/server/services/access-token.service.ts", "src/server/services/user-token-revocation.service.ts",
                  "src/server/jobs/revoke-user-tokens.ts",
                  # payment providers, payouts, redeemable value, refunds, tips
                  "src/server/services/coinbase.service.ts", "src/server/routers/coinbase.router.ts",
                  "src/pages/api/webhooks/coinbase.ts", "src/server/http/tipalti/tipalti.caller.ts",
                  "src/pages/api/webhooks/tipalti.ts", "src/server/services/creator-program.service.ts",
                  "src/server/routers/creator-program.router.ts",
                  "src/server/services/creator-program-prepayout-review/hold.ts",
                  "src/components/Buzz/CreatorProgramV2/CreatorProgramV2.tsx",
                  "src/server/services/redeemableCode.service.ts", "src/server/routers/redeemableCode.router.ts",
                  "src/server/services/blocks/app-workflow-refund.service.ts", "src/pages/api/v1/blocks/tip.ts",
                  # bounties and the vault
                  "src/server/services/vault.service.ts", "src/server/routers/vault.router.ts",
                  "src/pages/api/download/vault/[vaultItemId].ts", "src/pages/api/v1/vault/get.tsx",
                  "src/server/services/bounty.service.ts", "src/server/routers/bounty.router.ts",
                  "src/server/services/bountyEntry.service.ts",
                  "src/server/api-routes/mod/bounty-unpaid-award/resolve.ts",
                  "packages/civitai-shared/src/bounty-award.ts",
                  "src/pages/api/mod/[...path].ts", "src/pages/api/admin/[...path].ts",
                  "src/server/utils/api-router.ts",
                  "src/server/utils/api-routes/mod.generated.ts",
                  # CSAM, moderator gates and bans
                  "src/server/services/csam.service.ts", "src/server/routers/csam.router.ts",
                  "src/pages/api/mod/csam-upload.ts", "src/pages/api/internal/mod-gate.ts",
                  "src/server/api-routes/mod/ban-user.ts"]:
            with self.subTest(path=p):
                self.assertTrue(opc.money_hit(money, p), f"{p} is not matched by {REAL_MONEY}")
        for p in ["src/pages/index.tsx", "src/components/Image/x.tsx", "src/server/services/model.service.ts",
                  "packages/civitai-ui/src/button.tsx", "src/utils/trpc.ts", "src/server/trpc-helpers.ts",
                  "src/pages/bounties/index.tsx", "src/components/Vault/ToggleVaultButton.tsx",
                  "src/components/Banner/x.tsx", "src/pages/api/v1/blocks/list.ts"]:
            with self.subTest(path=p):
                self.assertIsNone(opc.money_hit(money, p), f"{p} (not money code) is matched by {REAL_MONEY}")

    def test_leaves_application_code_alone(self):
        # Positive control: the list must not forbid what an officer PR is FOR.
        for p in ["src/pages/index.tsx", "src/server/services/model.service.ts", "src/components/Image/x.tsx",
                  "src/shared/utils/prisma/enums.ts", "packages/civitai-ui/src/button.tsx",
                  "packages/civitai-db-schema/src/index.ts", "src/server/routers/image.router.ts",
                  # tests under src/ and packages/ are allowed (operator decision 2026-11-09)
                  "src/server/services/model.service.test.ts", "src/__tests__/pages/x.test.tsx",
                  "src/tests/api/x.test.ts", "packages/civitai-ui/src/__tests__/b.test.tsx",
                  # near misses of the charter-floor entries
                  "src/environment.ts", "src/server/env-utils.ts", "src/proxy.test.ts", "src/server/proxy.ts",
                  "src/server/middleware.ts", "packages/civitai-ui/src/vitest-helpers.ts",
                  "src/server/services/baseline.service.ts", "src/server/eslint-rules.ts",
                  # near misses of the src/__tests__/ setup-file globs: tests and fixtures there
                  "src/__tests__/service-worker.test.ts", "src/__tests__/mocks/db.mock.ts",
                  "src/__tests__/pages/setup.test.tsx"]:
            with self.subTest(path=p):
                self.assertFalse(self.forbidden(p), f"{p} (application code) is forbidden by {REAL_LIST}")

    def test_every_top_level_entry_but_src_and_packages_is_forbidden(self):
        r = subprocess.run(["git", "-C", REPO, "ls-tree", "-z", "HEAD"], capture_output=True, check=True)
        entries = [e for e in r.stdout.decode().split("\0") if e]
        self.assertGreater(len(entries), 10, "git ls-tree saw almost nothing; wrong checkout?")
        names = []
        for e in entries:
            meta, name = e.split("\t", 1)
            names.append(name)
            if name in ("src", "packages"):
                continue
            probe = name + "/x" if meta.split(" ")[1] == "tree" else name
            with self.subTest(entry=name):
                self.assertTrue(self.forbidden(probe),
                                f"top-level {name!r} is not forbidden: add it to {REAL_LIST} (the push gate has no allowlist)")
        self.assertIn("src", names)
        self.assertIn("packages", names)


if __name__ == "__main__":
    unittest.main(verbosity=1)
