---
paths:
  - "apps/moderator/**"
  - "apps/auth/**"
  - "apps/creator-studio/**"
---

# SvelteKit apps

Root CLAUDE.md covers the stack, the `typecheck`-not-`check` rule and the prettier-svelte ban; this file has the detail. Each app's `CLAUDE.md` records only its deltas from [`docs/svelte-app-standard.md`](../../docs/svelte-app-standard.md).

- Review a segment with `svelte-correctness-review`, `svelte-idiom-review` and `svelte-abstraction-review`.

## `typecheck` vs `check`

`typecheck` is `svelte-check` alone and writes nothing. `check` prefixes it with `svelte-kit sync`, which regenerates ~690 files under `.svelte-kit/`, a directory the Vite dev server watches.

Why: in an edit-verify loop, Vite re-optimising the module graph collided with `svelte-check` loading ~9,000 files and froze a day's work (2026-08-07). The main app doesn't have this problem because `tsc --noEmit` emits nothing.

- Don't run `svelte-kit sync` yourself before `typecheck` either: that is `check` by hand, with the same cost.
- Run `check` only after adding, removing or renaming a `+page`/`+server`/`+layout` file, the only time generated `$types` go stale. Symptoms: `Cannot find module './$types'`, or component props resolving to `never`. `prepare` runs `sync` on install, so a fresh checkout is covered.
- `build` runs `svelte-kit sync` too (`svelte-kit sync && vite build`), so it has the same cost and catches nothing `svelte-check` doesn't. It is not a check.
- Read `svelte-check`'s WARNING lines, not just ERROR. `state_referenced_locally` (`let x = $state(data.foo)` capturing only the first value, so the UI shows stale data after navigation) appears there and nowhere else. Filtering to `ERROR` hides it.

## Formatting `.svelte` files

`prettier --plugin=prettier-plugin-svelte` empties every file it touches to zero bytes and reports success (28 components in one command, 2026-08-07). The first symptom is `svelte-check` reporting props as `never`, which looks like stale `$types`.

- The root Prettier is 2.8.8 and globs `.ts`/`.tsx` only, so `pnpm run prettier:write` never formats `.svelte`.
- `apps/creator-studio` formats itself with its own Prettier 3 + plugin (`.prettierignore` explains why ownership must be exclusive). The other SvelteKit apps' `.svelte` files are hand-formatted.
