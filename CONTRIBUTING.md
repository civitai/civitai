# Contributing to Civitai

Thanks for contributing. This document covers the things that are easy to get
wrong here and hard to discover on your own — what CI actually checks, how to
verify your work locally, and a few conventions that have bitten us before.

For getting the app running at all, see [README.md](README.md).

## Fork PRs: what CI does and doesn't check

`civitai/civitai` is public, and a `pull_request` from a fork gets no repository
secrets. That is deliberate and is not going to change. The practical
consequences:

- **Workflows don't start on their own.** A fork PR parks at `action_required`
  until a maintainer clicks *Approve and run workflows*. If your PR looks like
  nothing is happening, that's why — please just ping in the PR.
- **Two things block.** Typecheck (full repo), and ESLint errors + Prettier on
  files your PR **adds**. New files start clean, so holding them to the rules is
  free. Typecheck runs on fork PRs too — it needs no secret, because the
  `event-engine-common` submodule is public and fetched over HTTPS.
- **Everything else is report-only.** ESLint and Prettier on files you *modify*
  run with `continue-on-error`, because a formatter has no changed-line
  granularity — 789 of 4,116 `src` files fail `prettier --check` today, so
  blocking on them would turn a three-line bugfix into a 200-line reformat. You
  will see a failed-but-ignored marker in the checks list. That's expected.
- **Unit tests run but don't block yet.** CI runs the unit suite (676 files,
  ~8,900 tests) report-only while we establish its pass rate on a CI runner — a
  handful of tests are slow enough to trip the 60s per-test timeout under load,
  though they pass in isolation. So a red unit job is a signal to look, not proof
  you broke something, and a green overall check doesn't mean the tests passed.
  Read the job output.
- **Component tests run in the PR-preview pipeline, report-only.** The 201
  `*.browser.test.tsx` files need real Chromium; they do not run in GitHub Actions,
  but the in-cluster preview pipeline runs them and posts a
  `preview / component-tests` commit status. It never blocks, so read it rather
  than relying on it.

A green check on a fork PR therefore means much less than it looks like. Verify
locally.

## The `event-engine-common` submodule

The repo depends on a submodule at `event-engine-common/`. It is public and
fetchable over HTTPS, but it is **not** checked out automatically:

```bash
git submodule update --init event-engine-common
```

Without it, `pnpm typecheck` fails with a wall of `Cannot find module` errors and
several dozen test files fail to *collect* — noise that looks like your change
broke something when it didn't. Same applies to any new git worktree; worktrees
don't check out submodules for you.

### If you cloned before the URL moved to HTTPS

Run this once:

```bash
git submodule sync --recursive
```

`git submodule init` writes the URL into `.git/config` the first time it runs and
never overwrites it afterwards — **including when that first attempt failed.** So
if you ever tried `--init` while the submodule was still private and got an auth
error, your clone has the old SSH URL recorded and `--init` will keep failing with
the identical error no matter how many times you pull. `sync` is the fix, and for
that case it is required, not optional.

The recorded URL also lives in the *shared* config rather than per-worktree, so
every existing and future worktree of that clone inherits it until you sync.

## Verifying locally

All of these need the repo's own toolchain — node `24.19.0` (the version in
`.nvmrc`) and pnpm 10.x. **Nothing stops you running them on the wrong node**:
`engines.node` is advisory, so `pnpm install` prints `WARN Unsupported engine`
and continues. That is why this is worth stating rather than leaving to the
tooling — the wrong major shows up as spurious test failures attributed to your
branch, not as an error at install time. On NixOS there is a second, louder
failure: outside the dev shell there are no `PRISMA_*_ENGINE_*` paths, so Prisma
goes looking for a `linux-nixos` engine that has never been published.

`nvm use` picks the right node up from `.nvmrc`; with Nix, prefix any of these
with `nix develop -c`, or use direnv (`cp .envrc.example .envrc && direnv allow`).

```bash
pnpm typecheck                 # full repo
pnpm test:unit:run             # ~8,900 unit tests, node env
pnpm test:component            # ~2,250 component tests in real Chromium, slower
pnpm exec prettier --check <files you added>
pnpm exec eslint <files you added>
```

Use `pnpm exec prettier --write <file>`, **not** `pnpm prettier:write -- <file>`.
The latter ignores the argument and reformats the entire repository.

Both suites use Vitest's own worker count (`cpus - 1`, or `min(12, cpus - 1)` for
the browser one). To leave the machine usable while a suite runs, size it for that
run with `--max-workers=8`, or with `VITEST_MAX_WORKERS=8` in the environment. The
number applies to every project and is not clamped, so a value above 12 raises the
Chromium instance count rather than lowering it.

### Compare against a baseline, not against zero

`pnpm test:component` can report two extra failing files on a cold
`optimizeDeps` cache, both `Vitest failed to find the runner`. Adding any
`*.browser.test.tsx` perturbs `optimizeDeps.entries` — see the comment at
`vitest.config.mts:98-124`. Re-run and it settles. If a file passes in isolation,
that's what happened.

The reliable method for any of these commands is to run it on unmodified `main`
first, save the output, then compare. A failure that also happens on `main` isn't
yours.

### `pnpm test:component` fails on ZERO COLLECTED, not only on red tests

The browser suite has a failure mode that runs **no tests at all** and, until you
read the numbers, looks exactly like an ordinary failure. `pnpm test:component`
runs through `scripts/test-component-run.mjs`, which asks vitest for a JSON report
and hands it to `scripts/ci/assert-component-suite-ran.mjs`. That gate prints a
ledger and applies three checks:

```
test:component ledger: 2254 executed, 0 skipped, across 201 files; 0 failed suites,
0 failed tests (baseline 2254 tests / 201 files measured 2026-08-31; 201 on disk;
floor 1240)
```

1. **Nothing collected fails** — always, on every invocation.
2. **A `*.browser.test.tsx` on disk that is absent from the report fails, and is
   named.** A file that stops being collected reports as *absence*, so no failure
   count and no per-test list can show it.
3. **A floor on executed tests**, as a backstop for a partial collapse that still
   leaves every file present.

The gate can only ever *add* a failure — vitest's own exit code is passed straight
through otherwise.

Three things to know before you run it with arguments:

- **A narrowed run skips checks 2 and 3. Check 1 always applies.** A file argument,
  `-t`, `--shard`, `--changed`, `--exclude`, `--dir`, `--root` and `--config` all
  count as narrowing, because each legitimately changes what gets collected.
- **`--outputFile` is refused** (exit 2), in every spelling that would collide with
  the report the gate reads. Run `pnpm exec vitest run --project component` directly
  if you want your own report.
- Flag values are consumed, so `--max-workers 1` is not mistaken for a filename.

Why it exists: a `vi.mock` factory that throws is resolved inside a Playwright
route handler that does not catch, so the rejection escapes as an
`Unhandled Rejection` in the orchestrator and kills the whole run — no
`Test Files` line, no per-file results, exit 1. The `preview / component-tests`
tier reads only the exit code, so that abort and a genuine list of red assertions
rendered identically. One such file zeroed all 201 suites on `main` at
`d353f785c3`. A browser crash under host load produces the same shape, wearing the
same misleading headline. The gate's message enumerates the causes it cannot tell
apart; read the error printed above it.

The commonest cause is a **wholesale** factory that stops naming an export
something in the file's module graph imports. `local-rules/no-wholesale-module-mock`
guards that for a listed set of modules, and
`src/components/AppBlocks/__tests__/featureFlagsMockCompleteness.test.ts` guards
the feature-flags module — but only under `src/components/AppBlocks`, so neither
covers you by default.

## Where tests go

**Never put test files under `src/pages`.** Next.js treats every `.ts`/`.tsx`
file there as a route — including nested `__tests__/` directories — and
`next build` runs a route-type validator over them. A Vitest file in that tree
fails the build with `Property 'default' is missing`, and **only `next build`
catches it**: typecheck, vitest and every CI job pass. It reaches the preview
build before anyone notices.

Put handler tests in a `__tests__/` directory outside `src/pages` (e.g.
`src/server/__tests__/`) and import the handler through the `~/pages/...` alias.

## Database migrations

**We do not use `prisma migrate deploy`.** Migrations are applied by hand, per
environment. Files in `packages/civitai-db-schema/prisma/migrations/` exist for
review and history; they are never auto-run, and the `_prisma_migrations` table
is not a source of truth.

So: write the SQL, commit it, and say so in your PR description — a maintainer
applies it. Don't suggest `prisma migrate deploy` or `prisma migrate resolve`.

Create migrations with `pnpm run db:migrate:empty "brief description"`. They must
land in `packages/civitai-db-schema/prisma/migrations/`, not the `prisma/migrations/`
directory at the repo root, which predates the monorepo and Prisma no longer reads.

## Branching: no stacked PRs

Base every PR directly on `main` (or on a feature integration branch), **never on
another open PR's branch.**

Stacked PRs mis-merge silently here: a squash-merged parent doesn't retarget its
child, so the child lands on the orphaned parent branch instead of the real base
and its changes vanish. This has cost us real work.

If your change depends on an unmerged PR, wait for it to merge and branch off the
updated base, or fold both changes into one PR.

## Scope and PR size

Smaller is genuinely better here — reviewer attention is the bottleneck. If a PR
contains one clearly-correct one-line fix plus a larger feature, split it. The
one-liner will merge in a day; the feature might take a week, and there's no
reason for the fix to wait.

If you find a second bug while fixing the first, prefer a separate issue or PR
over widening the one you're in.

## Writing it up

A good PR description explains **why the change is correct**, not just what it
does. Especially valuable:

- What you verified, and how. "Ran X, got Y" beats "should work".
- What you *didn't* change and why — deliberate omissions read as oversights
  otherwise.
- Anything you're unsure about. Flagging a shaky assumption is more useful than
  quietly hoping nobody checks.

If you discover your description was wrong after opening the PR, correct it in a
comment. That's a normal and welcome thing to do, not an admission of anything.

## Comments in code

Bias toward none. Comment the non-obvious *why* — a rationale, tradeoff, gotcha,
or workaround a reader can't recover from the code. Never narrate what the next
line does, and don't describe the current behaviour of nearby code; that's
exactly what goes stale. Comments aren't type-checked, so they rot silently.

## Getting help

Open an issue, or join the
[Community Development Team](https://civitai.com/articles/7782).
