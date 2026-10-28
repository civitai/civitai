# apps/knights

**Follow [`docs/svelte-app-standard.md`](../../docs/svelte-app-standard.md)** for runes, derive-the-promise,
keyed loops, form actions, comments and the review agents. Every SvelteKit app here shares it.

Knights of New Order as its own SvelteKit spoke, served at knights.civitai.com. It is deliberately free of
civitai.com's styling: plain CSS in `src/global.css`, no Mantine, no `@civitai/ui`, no Tailwind.

The game is moving here from the main Next.js app: `src/components/Games`,
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

## Queue (`src/lib/server/queue`)

Tables `KnightsQuestion`, `KnightsQueueItem` and `KnightsVote` (migration `20261210120000_knights_v2_queue`, applied by hand).
Everything takes the Kysely client as an argument so `queue.pglite.test.ts` runs the real service and the real migration
SQL on PGlite.

- `enqueueItem`: an item's `minRank` and `votesNeeded` default to its question's `minRank` and `votesToResolve`; an
  override on the item wins.
- `getFeed`: open items the player's rank may judge, higher stages first, then priority and age, from the first
  question in that order. Which ranks may judge a stage is `canVote` in `ranks.ts`, shared with `castVote`; Inquisitors
  and Acolytes get no feed. It never selects the image's rating. Hidden checks are not served yet (no grader).
- `castVote`: refuses what the feed would not serve (hidden check, inactive question, non-image), then one transaction
  that locks the item row, writes the ledger row with its weight, and decides the stage's votes (`resolution.ts`): 5 votes
  and a 60% weighted share resolves; a split stays open to 10, then moves up Knight -> Templar -> Inquisitor (Paladin has
  a vote weight but is not on `ESCALATION_PATH` yet). A rating more than one level below the image's current one, or a
  Blocked consensus, goes to Inquisitor. Votes stay `pending` across escalations and are graded by the final value.
- A settled rating is written by `main-app.ts` via the main app's `/api/mod/image/kono-set-nsfw-level` (activity
  `setNsfwLevelKono`) after the vote commits, with no lock held. The item is `Resolved` with `appliedAt` null until the
  call succeeds; `POST /api/jobs/expire` retries every unapplied one, so schedule it every few minutes.
- The vote ledger is partitioned by month. `POST /api/jobs/partitions` creates the next months and a vote creates its
  own month if missing; `POST /api/jobs/expire` escalates items past `expiresAt`. Both need
  `Authorization: Bearer $JOBS_TOKEN`; the user guard in `hooks.server.ts` skips `/api/jobs/`.
- `/play` is the minimal voting page. Acolytes get no feed and cannot vote (Trials is a later slice).

## Wired packages

`@civitai/auth` (guard), `@civitai/brand` (favicon), `@civitai/db` + `@civitai/db-schema` (Kysely, one client),
`@civitai/flipt` (access flag), `@civitai/redis` (sys client, only for the guard's session revocation check). Add others when a task needs them.

## Tests

`pnpm --filter @civitai/knights-app test` (project `app:knights`). Typecheck with `typecheck`, never `check`.
