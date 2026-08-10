# apps/creator-studio

**Follow [`docs/svelte-app-standard.md`](../../docs/svelte-app-standard.md)** — the shared conventions
for every SvelteKit app here (runes, derive-the-promise, keyed loops, form actions, `@civitai/ui`,
`text-dark-2`, placement, comments, the three review agents).

## Deltas

- **This app formats itself.** It is listed in the repo's `.prettierignore` and owns its formatting with
  its own **Prettier 3 + `prettier-plugin-svelte`**, run from this directory:

  ```bash
  pnpm -F @civitai/creator-studio-app format
  ```

  The root formatter is Prettier 2.8.8 and the two majors disagree about TypeScript (3 collapses
  leading-pipe unions that 2 breaks across lines), so ownership has to be exclusive or they fight over
  the same files forever. **Never run the root `prettier` over this directory**, and never run an ad-hoc
  `npx prettier --plugin=prettier-plugin-svelte` anywhere — outside this app's own configured script it
  empties `.svelte` files to zero bytes.

## Non-negotiables

Duplicated verbatim in every SvelteKit app's `CLAUDE.md` because **this file always loads and the
standard is one link away**. Each of these has cost real time when broken. Full reasoning and examples:
[`docs/svelte-app-standard.md`](../../docs/svelte-app-standard.md).

- **Derive the promise; never fetch in `$effect` and assign to `$state`.** The single most repeated bug
  in these apps — it gives a stuck spinner, a re-run loop, or a stale response landing on a newer
  lookup. `const x = $derived(browser ? fetch(...).then(r => r.json()) : null)`, then `{#await x}`.
- **Every `{#await}` needs a `{:catch}`.** Without one a rejection is silent and the panel just never
  fills in.
- **Key every `{#each}` on something unique.** An unkeyed or duplicate-keyed loop reuses the wrong DOM
  node, so a row's action button ends up wired to a different row. This is correctness, not lint.
- **A custom `use:enhance` callback must call `applyAction`.** It *replaces* the default handling, so
  without it every `fail()` is discarded and a refused action looks exactly like a successful one.
- **Optimistic UI must revert on failure.** A dim or a "handled" mark applied before the server answers
  and never undone makes the operator's own record wrong — and the item they skip is the one that failed.
- **Treat 0 affected rows as a failure, not a success.** Reporting success on zero writes an audit row
  for something that did not happen.
- **Gate an action on the page's own path, never a parent group node.** A group's grant is the union of
  its children, so gating on the parent silently widens who can act.
- **`typecheck`, never `check` — and `build` is not a check.** Both run `svelte-kit sync`, which fights
  the dev server's watcher; that collision froze an editor for a full day. Read `svelte-check`'s
  **WARNING** lines too: `state_referenced_locally` is a real bug and appears nowhere else.
- **Before calling a segment done**, run `svelte-correctness-review`, `svelte-idiom-review` and
  `svelte-abstraction-review` (or the `/svelte-review` skill) — then **look at the page**. Typecheck
  passes on plenty of pages that render blank.
