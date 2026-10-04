# Prettier in this repo

## Format uncommitted files only, never the whole repo

`pnpm run prettier:write` / `prettier:check` run `scripts/prettier-changed.mjs`, which formats only what git reports as dirty (modified vs HEAD plus untracked). Don't turn them back into a `**/*` glob, and don't run a repo-wide `npx prettier --write`.

Why: the repo is not Prettier-clean (~1,000 files across the workspace; `.github/workflows/lint.yml` counts 789 of 4,116 `src` files) and won't be until the 2->3 upgrade reformats it deliberately. A repo-wide write is a ~1,000-file commit that buries the real change and rewrites other people's uncommitted work in place (2026-08-08: one `prettier:write` modified 1,085 files).

CI scopes itself the same way and gates only on added files.

`.svelte` files are not covered by any root command; see `.claude/rules/sveltekit.md`.
