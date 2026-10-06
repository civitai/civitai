# Git worktrees

## Creating one

```bash
node .claude/skills/dev-server/cli.mjs wt new <name> <branch> [--no-install] [--base origin/<b>]
```

`wt new` fetches, runs `git worktree add -b <branch> --no-track <base>`, initialises the `event-engine-common` submodule, writes `.envrc` (`use flake`) when the primary checkout has one, copies every `.env` file from the primary (root, per-app, and the skills' credentials), runs `pnpm install` (unless `--no-install`; on Windows it launches the pnpm shim through a shell), and checks that `git status -sb` prints `## <branch>` alone. Don't hand-roll it, and don't create worktrees with the `EnterWorktree` tool: it puts the tree in `.claude/worktrees/` (outside the Defender-excluded repos root, so it runs slow) and branches the shorthand way, so the branch tracks `origin/main`. Entering an existing worktree with `EnterWorktree` `path:` is fine.

Worktrees live in `<repos-root>/worktrees/<name>`, with no prefix on the directory name. Keep them under the repos root: `.claude/skills/dev-server/scripts/defender-exclusions.ps1` excludes that path from Defender scanning, and a tree outside it runs slow. Run the script once with `-ReposRoot <repos-root>` to cover the parent (its default covers only the checkout it lives in).

## Why each flag matters

Never use the shorthand `git worktree add <path>` or `-b <branch> origin/main`. All of `fetch`, `-b`, the base, and `--no-track` are needed:

- **`git fetch origin main` first** keeps `origin/main` honest. Correct flags against a stale ref still fork from old code.
- **`-b <branch>`** creates a new branch and refuses if the name exists, so it can't check out a branch someone else is building on.
- **The `origin/main` base**: without it the branch forks from this worktree's `HEAD` (the local `main` you last pulled, not the real one).
- **`--no-track`**: `branch.autoSetupMerge` defaults to true, so `-b <branch> origin/main` also sets the upstream to `main`. A base and an upstream are different things, and git conflates them here.

Without `--no-track` the feature branch tracks `main` forever. `git status` reports it as diverged, and `git pull` **merges `origin/main` into the feature branch**, which is noise in the diff because this repo squash-merges. A healthy branch prints `## <branch>` alone, or `## <branch>...origin/<branch>` once pushed; `## <branch>...origin/main` is the broken state. Fix with `git branch --unset-upstream`, then `git push -u origin <branch>` on first push.

A bare `git worktree add <path>` is the other trap: it invents a branch named after the directory and forks it from local `HEAD`. Nothing errors; staleness shows up later as conflicts. Tell: branch name identical to the directory name.

## Removing one

Remove a worktree when its PR merges, with the CLI, not `git worktree remove` (which refuses whenever `event-engine-common` is checked out):

```bash
node .claude/skills/dev-server/cli.mjs wt stale        # what's finished, and what's blocking each keeper
node .claude/skills/dev-server/cli.mjs wt rm <path>    # stops the server, unlinks links, deletes, prunes
```

- `wt rm` refuses the primary worktree, a tree with uncommitted changes (`--force`), a tree with a running dev server (`--stop-server`), and a tree the dev-server daemon itself runs from.
- It deletes the branch only when `gh` reports a merged PR from this repo whose head contains the branch's local tip, keeps it when commits exist on no remote, and prints the SHA when it deletes.
- `wt stale` applies the same daemon check. A running daemon that won't say where it runs from (one predating PR #4641) blocks both: `wt stale` clears no tree and `wt rm` refuses (`--force` overrides that, but never a named holder). A daemon that is not running blocks nothing; a live daemon that errors on `/` still blocks.

## Checking merge state

Two obvious checks return success-shaped output while telling you nothing:

- **Don't use `git merge-base --is-ancestor <branch> origin/main`.** Squash-merging means a merged branch's tip is never an ancestor. Use `gh pr list --state all --head <branch> --json number,state,isCrossRepository,headRefOid`, and trust a MERGED row only when `isCrossRepository` is false and its `headRefOid` is your branch tip or contains it (`git merge-base --is-ancestor <branch> <headRefOid>`). `--head` matches the name alone, so a fork's PR or an old PR on a reused name comes back too. `wt stale` does this check for you.
- **Don't use `git log --not --remotes` with no positive rev.** It prints nothing, reading as "no unpushed commits". Use `git rev-list --count <branch> --not --remotes`.

## Traps in a fresh worktree

- **Always initialise the `event-engine-common` submodule** (`wt new` does): `git submodule sync --recursive && git submodule update --init event-engine-common`. Without it, `pnpm typecheck`/`build` fail with a wall of `Cannot find module '.../event-engine-common/...'` errors plus cascading `implicitly has an 'any' type`, which look like your change broke something.
- **Without the submodule a suite vanishes instead of failing.** `src/server/routers/__tests__/blocks.router.workflow.test.ts` fails to collect and contributes 0 tests; the run still reads as a pass. Validate any worktree test run by confirming that file collected a nonzero count (308 on one base). With the result cache on, the file may be legitimately absent because it was skipped as unchanged (the `[test-cache]` line says how many); then confirm it is outside your diff's reach, or run it by full filename, which bypasses the cache.
- **A fresh worktree gets none of the skills' credentials, and each one fails as though the skill
  were broken.** The dev server layers the APP's env chain (root `.env`, per-app `.env`);
  `.claude/skills/*/.env` is a different thing. Nothing copied it until `wt new` did — measured
  2026-10-05, the primary had 7 and a worktree 0 of 47 skill directories. The symptoms name no
  cause: `FLIPT_URL and FLIPT_API_TOKEN must be set`, `credentials not configured`, a bare 401.
  `wt new` now copies them and warns about any skill whose credentials exist in no tree. To see the
  state of a tree you already have, `wt env` reports one of three states per skill — never a value,
  because a per-skill inventory annotated with what each unlocks must not exist in a public repo:

  `set` (its own file), `root` (no file, but the root `.env` supplies every key it declares — most
  skills fall back to it) and `ABSENT`, which names the key that is blocking. An example carrying
  `# skill-env: settings-only` is local wiring, not credentials, and is not counted.

  ```bash
  node .claude/skills/dev-server/cli.mjs wt env                 # what this tree has
  node .claude/skills/dev-server/cli.mjs wt env <worktree>      # fill another tree's gaps
  node .claude/skills/dev-server/cli.mjs wt env --backup        # copy them OUTSIDE the repo
  node .claude/skills/dev-server/cli.mjs wt env --restore        # bring back what this tree lacks
  ```

  Neither direction overwrites a credential a tree already holds — a worktree may carry a
  different one deliberately. `--backup` exists because these files are one `git clean` from gone
  with nothing to restore from: a skill whose `.gitignore` lists `.env` loses it to `clean -x`, one
  without a `.gitignore` loses the untracked file to `clean -d`. Both happened — `discord` and `flipt`
  went missing from the primary while their siblings sat untouched since May, and discord's had to
  be re-obtained through an interactive browser login. The store sits outside the repo on purpose;
  a backup inside it dies to the same clean.

- **The app `.env` files are full copies, so they go stale.** `wt new` copies the root `.env`
  and every per-app one (any untracked `.env` / `.env.*` git finds, minus examples and `.bak`
  files) so a tree works outside the dev-server daemon too. The daemon still layers the primary's
  `.env` under the tree's, but a full copy restates every key and so masks later edits to the
  primary. After changing a primary `.env`, bring existing trees up to date with:

  ```bash
  node .claude/skills/dev-server/cli.mjs wt env <worktree> --refresh   # re-copies those the primary edited since
  ```

- **A fresh worktree has no `.envrc`** (gitignored; `wt new` writes `use flake` only when the primary checkout has one). Without it you silently get system Node instead of the flake's, and no `PRISMA_*_ENGINE_*` paths, so Prisma looks for a `linux-nixos` engine that was never published. Mismatched node produced spurious `window.localStorage is undefined` failures under happy-dom plus Prisma engine errors, all misattributed to the code under test. Fix: `cp .envrc.example <worktree>/.envrc && direnv allow`, or run commands through `nix develop`.
- **Confirm your cwd is actually the worktree.** A run whose cwd was a different repo lost two suites to collection failures and 77 tests silently never ran, with otherwise normal output.

## Browser/component tests on NixOS

Make the host's Playwright browser bundle match this repo's pin; fix the host, not `package.json`.

- **The failure is not "no `chromium` on `PATH`".** Playwright pins one exact Chromium build per release and looks it up by revision under `PLAYWRIGHT_BROWSERS_PATH` (nixpkgs `playwright-driver.browsers`). A mismatch fails with `browserType.launch: Executable doesn't exist at .../chromium_headless_shell-<rev>/...`, and the whole `component` project reports `Test Files (130)` / `Tests no tests`: 0 of 130 executed, which reads like a broken suite.
- **The pin is `^1.57.0` (Chromium revision 1200); adapt the host to it.** Compare the revision in `node_modules/playwright-core/browsers.json` with `ls $PLAYWRIGHT_BROWSERS_PATH`. If they differ, point `PLAYWRIGHT_BROWSERS_PATH` at a `playwright-driver` bundle of the matching version. Nixpkgs carries one playwright version per revision, so a host driving several repos on different playwright lines needs one pinned nixpkgs input per line and a per-project selector.
- **Do not bump the pin.** CI runs some Playwright jobs in version-matched container images that ship their own browsers while executing the workspace-local `./node_modules/.bin/playwright`; bumping this repo alone desynchronises that pair (the preview smoke suite went 2 passed / 59 failed, every one `Executable doesn't exist at /ms-playwright/chromium_headless_shell-1228/...`). A bump needs a lockstep image-tag change owned by someone else.
- **A caret range isn't a pin for a package with 1:1 browser mapping.** Floating within the 1.57 line is fine; bumping the minor changes the revision.
- **Escape hatch:** `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<abs path to chrome/chrome-headless-shell>`, honoured by `vitest.config.mts`'s provider, bypasses the revision lookup.
- **Before blaming any of this, clear `node_modules/.vite`.** A stale cache (typical after `kill -9`) hangs for minutes at near-zero CPU.
