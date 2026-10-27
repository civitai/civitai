# apps/knights

**Follow [`docs/svelte-app-standard.md`](../../docs/svelte-app-standard.md)** for runes, derive-the-promise,
keyed loops, form actions, comments and the review agents. Every SvelteKit app here shares it.

Knights of New Order as its own SvelteKit spoke, served at knights.civitai.com. It is deliberately free of
civitai.com's styling: plain CSS in `src/global.css`, no Mantine, no `@civitai/ui`, no Tailwind.

This is currently a shell. The game moves here from the main Next.js app: `src/components/Games`,
`src/server/services/games/new-order.service.ts` and `src/server/jobs/new-order-jobs.ts`. It keeps using the main
Postgres through `@civitai/db/kysely` and the existing `NewOrderPlayer` tables; do not add a second database.

## Access gate

Flipt flag `knights-of-new-order-app` (`KNIGHTS_APP_FLAG` in `src/lib/server/access.ts`), evaluated per user
through `@civitai/flipt`; the `testers` segment is configured in Flipt, not here. `src/hooks.server.ts` runs the
`@civitai/auth` spoke guard, then `accessFor` -> `decideAccess` (`src/lib/access.ts`, pure and unit-tested):

- anonymous: redirected to the auth hub sign-in
- moderator: always allowed
- anyone else: allowed iff the flag is on for them; flag missing or Flipt down fails closed
- denied: a plain "not yet open" page (403)

To open the app to everyone, drop the `accessFor` check in the hook.

## Wired packages

`@civitai/auth` (guard), `@civitai/brand` (favicon), `@civitai/db` + `@civitai/db-schema` (Kysely, one client),
`@civitai/flipt` (access flag), `@civitai/redis` (sys client, only for the guard's session revocation check). Add others when a task needs them.

## Tests

`pnpm --filter @civitai/knights-app test` (project `app:knights`). Typecheck with `typecheck`, never `check`.
