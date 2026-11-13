# Knights queue sources

Moved from `apps/knights/CLAUDE.md`. The enqueue contract lives in the main app: `src/server/services/knights/enqueue.service.ts`.

The enqueue contract is `{ source, questionKey, items: [{ imageId, priority: 1|2|3, minRank?, votesNeeded?, expiresAt?, prediction? }] }`.
It is implemented once, in the main app: `src/server/services/knights/enqueue.service.ts` (`enqueueKnightsItems`, one batch insert).
Per item it answers `enqueued` | `duplicate` | `refused` (refusal reasons: see the result type in `enqueue.service.ts`). Defaults and the stage-rank rule match `enqueueItem` here; the stage ranks and TTL live in
`@civitai/shared/new-order`. An open, Inquisitor or Ruling item for the same question and image makes a new one a duplicate; the partial unique
index `KnightsQueueItem_open_question_image_key` (migration `20261210120000_knights_v2_tables`, applied by hand, which also has the `prediction` column) closes the race.

- `POST /api/mod/knights/enqueue` (`src/pages/api/mod/knights/enqueue.ts`): a moderator session or full-access API key that also holds the
  `knightsEnqueue` grant. Up to 1000 items per call; a 200 does not mean every item was queued, read `results`. Unlike the producers below, it also refuses images the public feeds would not show (`not-servable`: `servableImage` in `@civitai/db/knights`).
- The image-scan pipeline (`scan-sample`: safe-looking priority 1, NSFW priority 2) and an owner's own rating (`owner-rating`, priority 1) also enqueue
  here, beside today's game, which is untouched. Both hooks live in `src/server/services/knights/sources.ts`, never throw into the scan, and are
  **off unless** the sys Redis key `system:knights-v2-sources` (`REDIS_SYS_KEYS.SYSTEM.KNIGHTS_V2_SOURCES`) holds
  `{"enabled":true,"sfwRate":1,"nsfwRate":0.3}`; a missing or unreadable key means off, rates are 0-1 samples per pool. Set it in sys Redis; no
  deploy needed.
- Inquisitor queue: moderator app `/knights-of-new-order/inquisitor` (own page grant). A moderator's rating goes through the moderator app's
  `updateImageNsfwLevel` (activity `setNsfwLevel`), the item closes (`moderator-ruled`) and its pending votes are graded against that level, Blocked included.
- Dev queue: with the migration applied to your local database, `cd apps/knights && pnpm run dev:enqueue-recent [count]` enqueues the newest eligible
  images (scanned, unlocked, and servable: published, level not 0 or Blocked, no block marker, no review hold; default 50, max 1000) as source `dev-backfill`. It reads `DATABASE_URL` from
  `apps/knights/.env`, is safe to repeat, and refuses to run unless the host is `localhost` or `127.0.0.1`.
