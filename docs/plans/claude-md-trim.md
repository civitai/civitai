# Proposal: trim the root CLAUDE.md to under 200 lines

## Why

The root `CLAUDE.md` is **959 lines / ~19.4K tokens**, and it is in the context of every session **and
every custom subagent** — each review lane pays it again. Every turn re-reads the whole context, so the
cost multiplies by turns × sessions × agents, for everyone on the team.

Anthropic's guidance ([memory docs](https://code.claude.com/docs/en/memory)):

> **Size**: target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce
> adherence. Move instructions that matter for only part of the codebase into path-scoped rules, which
> load only when Claude works with matching files.

And ([best practices](https://code.claude.com/docs/en/best-practices)): exclude "anything Claude can
figure out by reading code", "detailed API documentation (link to docs instead)", and "file-by-file
descriptions of the codebase".

Adherence matters as much as cost: the incident-driven warnings in this file are only useful if they
are followed, and the docs say length reduces that.

## How instructions can load (verified against the docs)

| Mechanism | Loads | Saves context? |
| --- | --- | --- |
| Root `CLAUDE.md` | Every session and every custom subagent, at launch | — |
| `@path` import | **At launch**, with the file that imports it | **No** — organisation only |
| `.claude/rules/*.md` with `paths:` | When Claude Reads/Writes/Edits a matching file | **Yes** |
| Nested `apps/x/CLAUDE.md` | When Claude reads a file in that directory | **Yes** (already used for 5 apps) |
| Skill | When relevant to the task, or invoked | **Yes** |
| `docs/` file + one-line pointer | When Claude follows the pointer | **Yes** |

Path-scoped rules also load for custom subagents when they read matching files, so a review lane reading
`src/server/**` still gets the server rules.

## The split

Section sizes are measured (bytes ÷ 4).

### Stays in root — applies to nearly every task (~3.5K tokens, ~180 lines)

| Section | Now | After | Change |
| --- | --- | --- | --- |
| How to work with us, inline comments | 54 | 54 | — |
| Filing follow-up work (both sections) | 678 | ~150 | Merge the two into one short rule; the incident narrative moves to `docs/` |
| Tech stack, monorepo layout, libraries | 400 | ~200 | Drop what `package.json` already says |
| Build / code quality / dev-server rule | 208 | 208 | — |
| Testing commands + "run covering suites, never `--project unit`" | 836 | ~200 | Keep the commands and the hard rules; details go to `rules/testing.md` |
| Prettier: uncommitted files only; never prettier-svelte | 453 | ~80 | One line each; history goes to `rules/sveltekit.md` / `docs/` |
| Database: edit `schema.full.prisma` only; migrations are manual | 337 | ~150 | Enum procedure goes to `rules/database.md` |
| Release needs permission | 90 | 90 | — |
| Comments standard | 758 | ~250 | Keep the rules and the keep test; the long rationale is already in the `comment-review` agent |
| Security (public repo, don't-commit list, doc check) | 661 | ~550 | Kept nearly whole — it applies to every commit |
| Before committing, stacked PRs | 343 | ~150 | — |
| Worktree recipe (the 6 commands + "check `## <branch>`") | — | ~120 | The rest of the 3K section moves out (see below) |
| Feature docs pointer | 447 | ~60 | "Check `docs/features/` first"; the table moves to `docs/features/README.md` |
| Next.js block (written by `next dev`) | 160 | 160 | Must stay — `next dev` re-adds it |

### Moves to path-scoped rules — load only when touching those files

| New file | `paths:` | Contents | Tokens |
| --- | --- | --- | --- |
| `.claude/rules/convention-guards.md` | `src/server/**`, `**/*.test.ts` | The convention-guard list and the `test:lint-rules` notes | 3,172 |
| `.claude/rules/testing.md` | `**/*.test.{ts,tsx}`, `**/__tests__/**`, `vitest.config.mts`, `scripts/test-cache/**` | Result cache, worker counts, no tests under `src/pages`, `importOriginal`, check-the-revert, self-deleting browser states | ~2,400 |
| `.claude/rules/server.md` | `src/server/**`, `src/pages/api/**` | Server architecture map, how jobs get scheduled | ~1,050 |
| `.claude/rules/database.md` | `packages/civitai-db-schema/**`, `**/migrations/**` | Enum expand/contract procedure, migration detail | ~700 |
| `.claude/rules/sveltekit.md` | `apps/{moderator,auth,creator-studio}/**` | `typecheck` not `check`, the prettier-svelte hazard, warnings in `svelte-check` | ~690 |
| `.claude/rules/components.md` | `src/components/**`, `src/pages/**/*.tsx` | Component patterns, `Popover` `withinPortal`, dialog registry | ~450 |
| `.claude/rules/debug-endpoints.md` | `src/pages/api/testing/**` | Debug endpoint convention | 261 |

### Moves to `docs/` (or a skill), with a one-line pointer in root

These are about shell work, not files, so a path rule can't trigger them:

- **Local development setup + "traps that cost hours"** (~1,700) → `docs/dev/local-setup.md`. Root keeps:
  "Setting up or debugging the local env? Read `docs/dev/local-setup.md` first."
- **Git worktrees, all but the recipe** (~2,900): NixOS/playwright bundle, `wt rm`/`wt stale`,
  merge-state checks, submodule and `.envrc` traps → `docs/dev/worktrees.md`, or into the `dev-server`
  skill next to `wt`.

### Delete — Claude can read this from the code

Troubleshooting (generic advice), "Common Patterns" (infinite scroll, modals, forms, uploads, images),
and the generic "Important Notes" behaviour list (~550 tokens).

## Result (as implemented)

The plan above was the first pass. What shipped went further:

- **Root `CLAUDE.md`: 959 lines / 77.7 KB → ~112 lines.** It keeps only what applies to nearly every
  task: working style, repo map, where knowledge lives, commands, tests, database, security, pre-commit.
- **Moved content was rewritten, not copied** — instruction first, incident history as one-line reasons,
  references checked against the code (two stale paths fixed).
- **Filing follow-ups** moved to `docs/dev/filing-follow-ups.md`; the `clickup` skill points at it.
- **Worktree creation** became `dev-server wt new`, which runs the recipe itself
  (`-b <branch> --no-track origin/main` after a fetch) with an integration self-test.
- **The generated Next.js block** stays at the end of `CLAUDE.md`, byte-identical, so `next dev` leaves the file alone.
- Measured starting context of a fresh session is in the PR description.

## What changed with it

- `no-lint-rules-script-drift.test.ts` reads the guard list from `.claude/rules/convention-guards.md`.
- Every agent, skill, doc, CI comment and code comment that cited a moved section now cites its new file.
- `docs-drift-review` was run over the change and its findings applied.

## Risks

- **A rule loads only when a matching file is touched.** A session that runs tests without reading a
  test file won't see `rules/testing.md`. That is why the hard "never" rules (`--project 'unit*'`, no
  repo-wide prettier, no full-suite loops) stay in root as one-liners, and why the hooks — which enforce
  several of them regardless — stay unchanged.
- **Incident history becomes less visible.** It still loads exactly when the relevant files are touched,
  which is when it matters.
- **Rules accumulate.** Once loaded, a rule stays in context for the rest of the session. A session that
  touches everything ends up near today's size; most sessions don't.

## Follow-ups this enables (not in this change)

- Measure whether review lanes should set `omitClaudeMd: true` and receive their context in the
  delegation prompt instead. The test-review lane already carries its own copy of the guard list.
- Add a size check (`wc -l CLAUDE.md` ≤ 200) so the file doesn't regrow.

## Rollout

One PR: the new rule files, the trimmed root, the moved docs, the test and comment updates. Measure a
fresh session's starting context before and after (`claude -p "ok" --output-format json` → cache
tokens).
