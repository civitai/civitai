# apps/auth

**Follow [`docs/svelte-app-standard.md`](../../docs/svelte-app-standard.md)** — the shared conventions
for every SvelteKit app here (runes, derive-the-promise, keyed loops, form actions, `@civitai/ui`,
`text-dark-2`, placement, comments, the three review agents).

This app is the **auth hub**: login, OAuth, sessions, and the cross-app session registry. It is small,
and it predates most of the standard.

## Deltas

- **It does not use `@civitai/ui` yet, and has no `text-dark-2`.** That is a gap, not an exemption —
  the small size is why it was skipped, not a decision. Adopt the primitives and the palette as you
  touch screens; don't hand-roll a control to match the existing hand-rolled ones.
- **Sessions are the product here.** `src/lib/server/auth/registry.ts` builds the cross-app session
  registry from `@civitai/auth`'s `SESSION_REGISTRY_KEYS` — one definition shared with every other app,
  so a logout or ban propagates. Never define those key strings locally; a second definition silently
  splits revocation.
- **It runs without redis.** The registry falls back to a no-op so the hub still serves logins with
  tracking and revocation skipped. Keep that fail-open shape when adding registry calls.
- **Built lazily, never at module load.** `vite build` evaluates modules, so anything reading
  `REDIS_*`/connecting at import time breaks the build. Construct on first use.

## Typecheck is clean — keep it that way

`pnpm run typecheck` is **0 errors, 1 warning** — `state_referenced_locally` in
`src/routes/login/+page.svelte`. The two errors this section used to list as known-failing (a `mapProfile`
implicit `any` in `providers.ts`, `_store` on `never` in `establish-session.test.ts`) are fixed, so any
error you see is yours.

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
- **A `$bindable` prop passed one-way can latch.** shadcn wrappers declare `checked`/`value`/`open` as
  `$bindable` and the primitive writes to them on click. Passed as a plain prop, that write is a
  child-local override Svelte discards only when the parent expression yields a *different* value than it
  last pushed — so any click whose new state leaves that prop unchanged (tri-state `off`→`mixed` is the
  classic) leaves the control showing the opposite of your data, through a re-render and a reset. Use
  function bindings — `bind:checked={() => expr, (v) => handler(v)}` — whenever the parent owns the state.
- **Gate an action on the page's own path, never a parent group node.** A group's grant is the union of
  its children, so gating on the parent silently widens who can act.
- **`typecheck`, never `check` — and `build` is not a check.** Both run `svelte-kit sync`, which fights
  the dev server's watcher; that collision froze an editor for a full day. Read `svelte-check`'s
  **WARNING** lines too: `state_referenced_locally` is a real bug and appears nowhere else.
- **Before calling a segment done**, run `svelte-correctness-review`, `svelte-idiom-review` and
  `svelte-abstraction-review` (or the `/svelte-review` skill) — then **look at the page**. Typecheck
  passes on plenty of pages that render blank.
