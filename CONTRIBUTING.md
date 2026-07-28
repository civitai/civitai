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
- **Only one thing is blocking.** ESLint (errors only) and Prettier on files your
  PR **adds**. New files start clean, so holding them to the rules is free.
- **Everything else is report-only.** ESLint and Prettier on files you *modify*
  run with `continue-on-error`, because a formatter has no changed-line
  granularity — 789 of 4,116 `src` files fail `prettier --check` today, so
  blocking on them would turn a three-line bugfix into a 200-line reformat. You
  will see a failed-but-ignored marker in the checks list. That's expected.
- **There is no test job.** The repo has ~870 unit test files and ~106 component
  test files, and CI runs none of them. They only execute when someone runs
  vitest locally. Please run them (below) — nothing else will.

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

```bash
pnpm typecheck                 # full repo
pnpm test:unit:run             # ~8,000 unit tests, node env, fast
pnpm test:component            # ~860 component tests in real Chromium, slower
pnpm exec prettier --check <files you added>
pnpm exec eslint <files you added>
```

Use `pnpm exec prettier --write <file>`, **not** `pnpm prettier:write -- <file>`.
The latter ignores the argument and reformats the entire repository.

### Compare against a baseline, not against zero

`pnpm test:component` can report two extra failing files on a cold
`optimizeDeps` cache, both `Vitest failed to find the runner`. Adding any
`*.browser.test.tsx` perturbs `optimizeDeps.entries` — see the comment at
`vitest.config.mts:98-124`. Re-run and it settles. If a file passes in isolation,
that's what happened.

The reliable method for any of these commands is to run it on unmodified `main`
first, save the output, then compare. A failure that also happens on `main` isn't
yours.

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
