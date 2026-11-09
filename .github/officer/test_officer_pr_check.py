#!/usr/bin/env python3
"""Self-test for officer_pr_check.py and the REAL forbidden-paths.txt / bot-logins.txt.

Run: python3 .github/officer/test_officer_pr_check.py   (standard library + git only)

Three groups:
  * GlobGrammar: the ported push-gate grammar, pinned on literal cases.
  * Fixture: throwaway git repos in a temp dir; the checker runs as CI runs it
    (`check <base> <head>`, `arm <base> <ref> <author>`), and each wall must go RED on the
    change it exists to catch, with its own reason (a head adds a regression test unless
    the test is about that rule, so a refusal is never check 4's by accident).
  * RealList: the committed list parses, forbids each class the policy names, leaves
    ordinary application code alone, and forbids EVERY top-level entry of this checkout
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

    def test_parse_list_refuses_a_bad_line(self):
        self.assertEqual(opc.parse_list("# c\n\n  a/  \r\nb\n"), ["a/", "b"])
        with self.assertRaises(opc.Fatal):
            opc.parse_list("ok\nbad[x]\n")


class Fixture(unittest.TestCase):
    LIST = "package.json\npnpm-lock.yaml\npackages/civitai-db-schema/prisma/\n**/migrations/**\n.github\n.env*\nDockerfile*\nscripts\n"

    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="officer-pr-check-")
        self.g("init", "-q", "-b", "main")
        self.write(".github/officer/forbidden-paths.txt", self.LIST)
        self.write(".github/officer/bot-logins.txt", "# bots\n# placeholder[bot]\nCivitai-Officer-X[bot]   # x\r\n")
        self.write("src/app.ts", "export const a = 1;\n")
        self.write("src/old/keep.ts", "x\n")
        self.write("src/old/keep.test.ts", "x\n")
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

    def test_modified_test_under___tests___counts(self):
        self.write("packages/civitai-ui/src/__tests__/b.ts", "test('b', () => {});\n")
        self.write("packages/civitai-ui/src/b.ts", "export const b = 2;\n")
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
    def arm(self, ref, author):
        return self.run_checker("arm", "base", ref, author)

    def test_arm_officer_prefix(self):
        rc, out = self.arm("officer/release-followup/12-fix", "SomeHuman")
        self.assertEqual(rc, 0, out)
        self.assertIn("armed=true", out)

    def test_arm_listed_bot_on_any_branch_case_insensitive_crlf(self):
        rc, out = self.arm("fix/oom", "civitai-officer-x[bot]")
        self.assertEqual(rc, 0, out)
        self.assertIn("armed=true", out)
        self.assertIn("officer bot author", out)

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
        self.g("checkout", "-q", "--detach", "base")
        self.g("rm", "-q", ".github/officer/bot-logins.txt")
        self.g("commit", "-q", "-m", "no logins")
        self.g("branch", "-f", "base", "HEAD")
        self.assertEqual(self.arm("fix/oom", "SomeHuman")[0], 2)
        # ...but an officer/ ref still arms without the list.
        self.assertIn("armed=true", self.arm("officer/x/1-y", "SomeHuman")[1])


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
                  ".github/officer/officer_pr_check.py", "scripts/ci/x.mjs", "packages/civitai-ui/scripts/x.mjs",
                  ".env", ".env.production", "src/.env.local", "Dockerfile", "packages/x/Dockerfile.dev",
                  "docker-compose.yml", ".husky/pre-commit", "CLAUDE.md", "src/AGENTS.md", ".gitattributes",
                  "src/x/.gitattributes", "event-engine-common", "apps/moderator/src/x.ts"]:
            with self.subTest(path=p):
                self.assertTrue(self.forbidden(p), f"{p} is not forbidden by {REAL_LIST}")

    def test_leaves_application_code_alone(self):
        # Positive control: the list must not forbid what an officer PR is FOR.
        for p in ["src/pages/index.tsx", "src/server/services/model.service.ts", "src/components/Image/x.tsx",
                  "src/shared/utils/prisma/enums.ts", "packages/civitai-ui/src/button.tsx",
                  "packages/civitai-db-schema/src/index.ts", "src/server/routers/image.router.ts",
                  # tests under src/ and packages/ are allowed (operator decision 2026-11-09)
                  "src/server/services/model.service.test.ts", "src/__tests__/pages/x.test.tsx",
                  "src/tests/api/x.test.ts", "packages/civitai-ui/src/__tests__/b.test.tsx"]:
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
