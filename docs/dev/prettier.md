# Prettier in this repo

Root CLAUDE.md has the rule (uncommitted files only, never repo-wide). This is the why.

## How the scripts are scoped

`pnpm run prettier:write` / `prettier:check` run `scripts/prettier-changed.mjs`, which formats only what git reports as dirty (modified vs HEAD plus untracked). Don't turn them back into a `**/*` glob.

Why: the repo is not Prettier-clean (~1,000 files across the workspace; `.github/workflows/lint.yml` counts 789 of 4,116 `src` files) and won't be until the 2->3 upgrade reformats it deliberately. A repo-wide write is a ~1,000-file commit that buries the real change and rewrites other people's uncommitted work in place (2026-08-08: one `prettier:write` modified 1,085 files).

CI scopes itself the same way and gates only on added files.

`.svelte` files are not covered by any root command; see `.claude/rules/sveltekit.md`.
