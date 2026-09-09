---
name: civitai-worktrees
description: Setting up a fresh git worktree in the Civitai monorepo so its test runs are trustworthy — initializing the `event-engine-common` submodule (without it a suite collects ZERO tests and still reads as a pass), creating the gitignored `.envrc`, and matching a NixOS host browser bundle to the repo playwright pin. Use after creating a worktree, or when a worktree test run looks wrong. The creation recipe and its safety rules stay in CLAUDE.md.
---

# Civitai worktree setup

CLAUDE.md carries the `git worktree add` recipe and the flag rules. This file carries what to do to a
tree once it exists, and the silent failures that follow from skipping it.

When you create a new worktree, **always initialize the `event-engine-common` submodule
in it**: `git submodule sync --recursive && git submodule update --init event-engine-common`.
Worktrees don't check out submodules automatically,
and without it `pnpm typecheck`/`build` fail with a wall of `Cannot find module '.../event-engine-common/...'`
errors (and the missing types cascade into unrelated `implicitly has an 'any' type` errors) — noise that looks
like your change broke something when it didn't.

**The worse consequence is a suite that doesn't fail — it vanishes.** Without the submodule,
`src/server/routers/__tests__/blocks.router.workflow.test.ts` fails to **collect** and contributes **0 tests**.
It doesn't report red, it reports nothing, and a run that collected nothing still finishes in a way that reads
as a pass to anyone checking an exit code or skimming a summary. **Validate any worktree test run by confirming
that file collected a nonzero count** — it was 308 tests on one base. If it reports 0, the run tells you nothing
about your change, whatever the summary says.

**A fresh worktree also has no `.envrc`.** It's gitignored, so it never comes with the checkout, and you silently
get system Node instead of the flake's pinned version. Measured (when the flake still shipped node 22): system
Node **26.5.0** against the flake's **22.22.2** produced 7 spurious `window.localStorage is undefined` failures
under happy-dom plus 8 Prisma `linux-nixos` engine errors — every one a false red that got attributed to the code
under test. The flake now ships **24.19.0**, matching `.nvmrc`, so the version gap is smaller — but the *Prisma*
half is unchanged and does not care about the gap: without the flake's env there are no `PRISMA_*_ENGINE_*` paths
at all, and prisma goes looking for a `linux-nixos` engine that has never been published.
`cp .envrc.example <worktree>/.envrc && direnv allow`, or run commands through `nix develop`.
**Then confirm your cwd is actually the worktree**: one run
whose cwd was set to a different repo lost two suites to collection failures and **77 tests silently never ran**
(10849 → 10772) while the output otherwise looked entirely normal.

**Browser/component tests on NixOS: the host's browser bundle must match this repo's playwright pin — fix the
host, not `package.json`.**
The failure is *not* "no `chromium` on `PATH`" — a NixOS host that sets `PLAYWRIGHT_BROWSERS_PATH` (nixpkgs
`playwright-driver.browsers`) already has Chromium. Playwright pins **one exact Chromium build per release** and
looks it up by revision under that path, so a driver/bundle mismatch fails with
`browserType.launch: Executable doesn't exist at .../chromium_headless_shell-<rev>/...` — and the whole
`component` project then reports **`Test Files (130)` / `Tests no tests`**, i.e. 0 of 130 executed. That reads
like a broken suite, not a missing browser.

**The repo pin is `^1.57.0` and stays there — adapt the host to it.** `playwright` / `@playwright/test` resolve
to **1.57.0**, which wants Chromium revision **1200**. Before running, check the two numbers that have to be
equal: `node_modules/playwright/../playwright-core/browsers.json` (the revision playwright will look for) against
`ls $PLAYWRIGHT_BROWSERS_PATH` (the revisions the bundle actually has). If they differ, point
`PLAYWRIGHT_BROWSERS_PATH` at a `playwright-driver` bundle of the *matching* version instead of bumping the repo.
Nixpkgs carries exactly one playwright version per revision, so a host that drives several repos on different
playwright lines needs one pinned nixpkgs input per line and a per-project selector — the version skew is a
property of the host, not of this repo.

**Do not "fix" this by bumping the pin — the bump is not self-contained.** It was tried and reverted. CI runs
some Playwright jobs in **version-matched container images that ship their own browsers** (`PLAYWRIGHT_BROWSERS_PATH`
pointing inside the image) while executing the *workspace-local* `./node_modules/.bin/playwright`. Bumping this
repo alone desynchronises that pair and reproduces the same bug in CI: the preview smoke suite went **2 passed /
59 failed**, and every one of the 59 was `browserType.launch: Executable doesn't exist at
/ms-playwright/chromium_headless_shell-1228/...` — 177 occurrences (59 × 3 retries) and **zero** assertion or
timeout failures. Not one spec executed. So a bump needs a lockstep image-tag change owned by someone else, in
the same window, in both directions. Adapting the host costs one person nothing and no one else anything.

A caret range is also not a pin for a package with a 1:1 browser mapping: `^1.57.0` floating within the 1.57
line is fine (the Chromium build is stable across a minor line), but bumping the *minor* changes the revision.

Escape hatch if your host's bundle can't match the pin: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<abs path to a
chrome/chrome-headless-shell binary>` — honoured by `vitest.config.mts`'s provider, and it bypasses the revision
lookup entirely. Before blaming any of this: **a stale `node_modules/.vite` cache — typical after a `kill -9` —
hangs for minutes at near-zero CPU. Clear it first.**


## Verifying merge state before removing a worktree

`wt rm` handles this for you. If you check by hand instead, these two are the traps CLAUDE.md points here for:

**Two checks that fail *clean* if you verify merge state yourself.** Both return success-shaped output
while telling you nothing:
- `git merge-base --is-ancestor <branch> origin/main` — this repo squash-merges, so a merged branch's tip
  is never an ancestor. It reported "not merged" for 24 of 26 branches, including ones demonstrably in
  `main`. Use `gh pr list --state all --head <branch>`.
- `git log --not --remotes` with **no positive rev** prints nothing, which reads as "no unpushed commits."
  It has nothing to list commits *from*. Use `git rev-list --count <branch> --not --remotes` — run
  correctly, six branches turned out to hold commits that existed on no remote at all.

`wt rm` itself refuses the primary worktree, a tree with uncommitted changes (`--force`), and a tree with a
running dev server (`--stop-server`). It deletes the branch only when `gh` reports a **merged** PR, keeps it
when commits exist on no remote, and prints the SHA when it does delete. Left alone, worktrees accumulate:
22 stale ones were removed in one sweep on 2026-08-12, 15 with already-merged PRs.
