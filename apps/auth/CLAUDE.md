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

## Known-failing typecheck

Two errors predate this file and are on `main`; they are not yours if you see them:

- `src/lib/server/auth/providers.ts` — `Parameter 'p' implicitly has an 'any' type` (the `mapProfile`
  stub)
- `src/lib/server/auth/__tests__/establish-session.test.ts` — `Property '_store' does not exist on type
  'never'`
