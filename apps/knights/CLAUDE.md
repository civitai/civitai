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

- anonymous: a page load is redirected to `/welcome?next=<path>` (`lib/welcome.ts`, public in the hook); its "Sign in with Civitai" is the guard's own login URL with the sanitised `next` as return-to, and a signed-in visitor to `/welcome` goes to `/`. API and non-page requests keep the hub redirect
- moderator: always allowed
- anyone else: allowed iff the flag is on for them; flag missing or Flipt down fails closed
- denied: a plain "not yet open" page (403)

To open the app to everyone, drop the `accessFor` check in the hook.

## Queue (`src/lib/server/queue`)

Tables `KnightsQuestion`, `KnightsQueueItem` and `KnightsVote` (migration `20261210120000_knights_v2_queue`, applied by hand).
Everything takes the Kysely client as an argument so `queue.pglite.test.ts` runs the real service and the real migration
SQL on PGlite.

- `enqueueItem`: an item's `minRank` and `votesNeeded` default to its question's `minRank` and `votesToResolve`; an
  override on the item wins. `minRank` must be a stage rank (Knight, Templar, Paladin); anything else throws.
- `getFeed`: open items the player's rank may judge, higher stages first, then priority and age, from the first
  question in that order. Which ranks may judge a stage is `canVote` in `ranks.ts`, shared with `castVote`; Inquisitors
  and Acolytes get no feed. It never selects the image's rating and never returns a hidden check (see Hidden checks and smites).
  Only images the public feeds would show are served (`servableImage` in `@civitai/db/knights`, shared with `getFeed`, `castVote`, the apprenticeship, the harvest and the dev script): an image-type, published post, level not 0 or Blocked, no block marker, no review hold.
- `castVote`: refuses what the feed would not serve, then one transaction that locks the item row, refuses a vote
  that would weigh 0 (`no-weight`), writes the ledger row with its weight, and decides the stage's votes (`resolution.ts`): 5 votes
  and a 60% weighted share resolves; a split stays open to 10, then moves up Knight -> Templar -> Inquisitor (Paladin has
  a vote weight but is not on `ESCALATION_PATH` yet). A rating far below the image's current one, or a
  Blocked consensus, goes to Inquisitor. Votes stay `pending` across escalations and are graded by the final value.
- A settled rating is written by `main-app.ts` via the main app's `/api/mod/image/kono-set-nsfw-level` (activity
  `setNsfwLevelKono`; authenticated with `WEBHOOK_TOKEN` in the `x-webhook-token` header, env in `.env.example`) after the vote commits, with no lock held. That endpoint is the gate: it writes only onto an image
  that exists, has no block marker and is unlocked or Knights-locked, and answers 200 `applied` or `skipped`
  (`missing` | `blocked` | `locked`, with the image's current level). Until then the item is `Resolved` with `appliedAt`
  null and `resolvedFromLevel` set; `POST /api/jobs/tick` retries every due one (and escalates expired items), so schedule it every few minutes.
  - Each try claims the item first (attempt count + two-minute lease). A throw (5xx, network, unintelligible answer) is
    transient: backoff 5, 10, 20 ... up to 6h, and after 8 tries the item goes to the Inquisitors (`attempts-exhausted`).
    Untried rows run before those that already failed; a run does 4 at a time within a 45s budget.
  - A retry that finds the image at the settled level under the Knights lock (`KNIGHTS_VOTE_NSFW_LEVEL_REASON`, in
    `@civitai/shared/new-order`) counts as written: an earlier try's answer was lost after the main app applied it.
  - A skip, or an image that is blocked, moderator-locked or at another level than `resolvedFromLevel`, is final and is
    never retried. Blocked or moved: Inquisitor, votes pending again. Moderator-locked: `Closed` with votes graded against the
    moderator's current level (as v1 does when a moderator finalizes), or Inquisitor (`moderator-locked`) when that level
    is unknown. Gone: `Closed`, votes inconclusive. `reason` says which.
  - Once a vote commits, a failure settling it is logged and the player still gets the accepted answer; the item stays
    `Resolved` and the job retries it.
- Vote pacing (`queue/vote-rate.ts`): `castVote` returns `{ status: 'limited', until }` while the trailing windows in `VOTE_LIMITS` are full, counted from `KnightsVote` itself (no Redis, no state of its own). A per-player `pg_advisory_xact_lock` taken first in the vote transaction, ahead of the item lock, serialises one player's votes, and the limit is re-checked under it, so parallel requests cannot overshoot. Moderators are exempt, and a `QueueDeps` without `voteLimits` is unpaced (tests, the dev simulator). The vote action answers 429 with `lockoutSeconds`; `/play` `load` (`depends('app:play')`) carries `lockoutSeconds`, shown by `$lib/Countdown.svelte`, which re-checks the server when it reaches zero.
- Block reasons (`lib/block-reasons.ts`, migration `20261227120000_knights_v2_block_reason`, by hand; `KnightsVote.blockReason`, a CHECKed text column): a Knight or higher who picks Blocked on the rating question (feed items and hidden checks alike) must send one of the original game's five reasons (Inappropriate Minors, Realistic Minors, Depicts Real Person, Bestiality, Other), and every other answer must send none. `insertVote` enforces the pairing (`bad-block-reason`, answered 400, nothing written); a hidden check is still graded on the level alone. `/play` opens `BlockReasons.svelte` on the Blocked pill or key (keys 1-5, Esc cancels; covers the answer row on desktop, a bottom sheet at 640px and under) and casts the vote when a reason is picked. Acolyte apprenticeship answers ask for none. The Inquisitor card in the moderator app shows the most common reason among the Blocked votes (a tie goes to the earliest vote's reason).
- Skips (`lib/server/skips.ts`, `?/skip` on `/play`): a Skip button, Space, and the page's own image-error check all post the sealed token to one action. It is not a vote: no ledger row, pay, accuracy or Watch credit, and no pacing. The token's kind and id go into a per-player Redis sorted set (`knights:skipped:<id>`, newest 1000, 90 days), and `getFeed`, `pickHiddenCheck` and `pickYesNo` take it as `exclude`. Every kind is recorded and answered alike, so a skip does not reveal a hidden check; a skipped check is never graded, and the slot still yields a hidden check while the pool lasts, so skipping does not lower a player's rate. A store that is down serves as if nothing was skipped. The apprenticeship has no skip.
- The vote ledger is partitioned by month. `POST /api/jobs/partitions` creates the next months and a vote creates its
  own month if missing; `POST /api/jobs/tick` also escalates items past `expiresAt` and settles votes on final items (`settledVotes` in its response; any failing step (including the Conversion steps below), or an item that could not be settled, returns 500; the response also carries `conversionsRetried` and `labels`). Both need
  `Authorization: Bearer $JOBS_TOKEN`.
- The user guard in `hooks.server.ts` skips exactly the routes in `JOB_PATHS` (tick, partitions, harvest, notify); a new job route must be added there. `POST /api/jobs/notify` sends the opt-out daily-loop notifications (`src/lib/server/notify`, table `KnightsNotificationSend`, migration `20261217120000_knights_v2_notify`, by hand): see "Knights of New Order daily notifications" in `docs/features/notifications.md`.
- `/play` is the minimal voting page, with a status line (rank, level and XP from `@civitai/shared/new-order-levels`, the apprenticeship meter for Acolytes, and the progression standing described under Progression). Acolytes get the apprenticeship instead of the feed and cannot vote; a user with no `NewOrderPlayer` row is redirected to `/` to join (see Joining), as is `/judgments` (`requireMember`, `lib/server/membership.ts`), and an apprenticeship answer from such a user is refused; Knights and above keep the feed. It also shows the Daily Watch panel and the dismissable recap (see Daily loop); `/ranks` lists each rank's daily gold cap. Hidden checks and smites: [`docs/features/knights-hidden-checks-and-smites.md`](../../docs/features/knights-hidden-checks-and-smites.md) (migration `20261219120000_knights_v2_smites`, by hand; values in `hidden/config.ts`, env, and `smites/config.ts`). Never put a raw item id in the page: every feed item is a sealed token (`feed-token.ts`), and a hidden check is an ordinary `KnightsVote` (negative `itemId`, graded later by `settleHiddenChecks`). Active smites are the pending record of a career reset; the tick retries it. Yes/no questions (`KnightsQueueItem` rows with an `audience`, served in stretches, labelled per answer, `pnpm run import:yesno <csv>`): [`docs/features/knights-yesno-questions.md`](../../docs/features/knights-yesno-questions.md) (migration `20261221120000_knights_v2_yesno`, by hand, after `20261211120000_knights_v2_sources`, which it amends). The notify job's new-images check counts rating items only.

## Banned and muted accounts

`getStanding(db, userId)` (`lib/server/standing.ts`) reads the database, never the session. Banned or deleted: the closed page (403) on every route except the job routes. Muted: may view and convert gold, but `vote`, `skip`, `apprentice` and `restart` answer 403. Detail: [`docs/features/knights-standing.md`](../../docs/features/knights-standing.md).

The layout carries a small nav: "Back to Civitai" (`CIVITAI_APP_URL`) and "Sign out" (`/logout`, a GET).

## Joining

`/` shows "Join the Order" to a user with no `NewOrderPlayer` row: a sensitive-content warning (explicit imagery regardless of the user's browsing level), then the `join` action, which requires `accepted=yes`, calls `joinOrder` (`lib/server/join.service.ts`, the only place an Acolyte row is created; idempotent, never touches an existing row) and redirects to `/play`. `/play` redirects a user with no row back to `/`. The v1 Acolyte badge cosmetic is not awarded here yet.

`/rules` is the player-facing rules page. Its numbers come from `rulesFacts()` (`lib/server/rules.ts`), which reads the apprenticeship, progression, daily and rank config; the rating guide reads the shared level labels. Update the page when a rule changes. Vote pacing is deliberately not described there (public repo).

## Progression (`src/lib/server/progression`)

Migration `20261213120000_knights_v2_progression` (applied by hand): `KnightsVote.xp` / `settledAt`, `NewOrderPlayer.goldPending` / `goldEarned`. Progression amounts are in `progression/config.ts`; the Watch, streak and shield amounts are in `daily/config.ts` and the per-rank daily gold cap is in `ranks.ts` (see Daily loop).

- A vote pays the vote XP at once and records `gold` as pending on the vote and in `goldPending`: base x the voter's rank multiplier x `RATING.belowBarFactor` while below the bar, then clamped to what is left of the rank's daily cap (see Daily loop). A clamped vote records the clamped amount, so settling drops or keeps only that.
- `settleItemVotes` pays a graded item once, only when its outcome is final (`Closed`, or `Resolved` and written back): correct = bulk XP, gold moves pending -> earned; wrong or inconclusive = gold dropped. `settledAt` plus the row lock make it idempotent. It runs in the transaction of every Knights path that finalises an item, and `POST /api/jobs/tick` sweeps (`settleFinalItems`) what other apps closed (the moderator app's rulings).
- Fervor is never stored: v2 does not write `NewOrderPlayer.fervor`, which the original game's `newOrderDailyReset` job rewrites for every player. It is read from the vote ledger, the player's graded settled votes **cast** in the last `PROGRESSION.fervorWindowDays` (7) days, no cap, since `startAt` (`progression/fervor.ts`, `fervorLedgerOf`; the status line computes it live). `createdAt` prunes the monthly partitions and matches the original board. Migration `20261228120000_knights_v2_fervor_window` (by hand, after `20261227120000_knights_v2_block_reason`, then deploy Knights; without it the board's read is unindexed but correct) is the partial `(createdAt, playerId) INCLUDE (verdict)` index for the board's grouped read; one player's read uses `(playerId, createdAt)`. Accuracy and rank do not decay: they stay on `ledgerOf`, the last `PROGRESSION.accuracyWindow` (500) graded votes. A career restart does not touch the column either; `startAt` voids the earlier votes.
- Ranks: `progression/rating.ts`, knobs in `config.ts` (`RANK_LADDER`, `RATING`). Accuracy reads `ledgerOf` (last 500 graded votes, not time-bound) and is "not yet rated" below `RATING.minGraded`.
- `/leaderboard` (`leaderboard.ts`, in the avatar menu): the rolling weekly board, from `KnightsVote`, `NewOrderPlayer` and `User` only (not the main app's `Leaderboard` tables). Knight, Templar and Paladin with fervor > 0, highest first (lower user id on a tie), banned and deleted accounts left out, top `LEADERBOARD_SIZE` (100) plus the viewer's own position when outside them. The whole ranked list is built by one grouped read once per UTC day and kept in process memory and in sys Redis (`knights:leaderboard:<UTC date>`, `leaderboard-cache.ts`; every Redis call is raced against a 400ms clock and a down store just means a direct read; one build per process, two instances may each build once). The page shows a podium for the top 3, rows from 4 down, and the viewer's standing with the gap to the place above (`standingGap`), plus a collapsible "How fervor works" panel whose numbers come from `PROGRESSION` (`leaderboard-view.ts`, also the "next tally" time to UTC midnight). Each row shows the avatar (the profile picture when it is rated PG, `nsfwLevel` 1, else `User.image`; `Avatar.svelte`), and the rank's badge cosmetic image (`Cosmetic.data.url` of 859 Knight / 860 Templar, read in the same build); Paladin has none, and a failed image shows `RankEmblem`.
- Rank-up runs in `settleItemVotes` after XP is added; it can skip ranks and never demotes, and never touches Acolyte or Inquisitor.
- Migration `20261214120000_knights_v2_paladin_rank` (by hand, after the client with `Paladin` is deployed everywhere, dev included: an old client throws on the Paladin `NewOrderRank` row): enum value plus `NewOrderRank` row.
- `/dev/simulate` 404s unless SvelteKit's build-time `dev` is true; it also has "Set level" (`dev/set-level.ts`) and shows accuracy.
- XP is also added to the original game's Redis exp counter (`new-order:exp`, only when that player's field is present) after the commit, while both games run: its nightly reset overwrites `NewOrderPlayer.exp` from that counter, and an absent field is re-read from Postgres, which already holds the XP.

## Daily loop (`src/lib/server/daily`)

Tables `KnightsPlayer` (streak, shields, recap dismissal) and `KnightsPlayerDay` (votes, gold recorded, Watch, bonus per UTC day), migration `20261215120000_knights_v2_daily` (applied by hand). Knobs: `daily/config.ts`; the per-rank gold cap is `dailyGoldCap` in `RANK_RULES` (`ranks.ts`). Days are UTC strings (`days.ts`); logic takes the clock as an argument.

- `castVote` calls `recordVoteDay` only after locking the player's `NewOrderPlayer` row; that lock is what makes the day row safe. The streak bonus is earned gold, not cap gold.
- Streak and shields are pure (`streak.ts`). A shield is granted lazily per ISO week and spent when the next Watch completes, covering exactly one missed day. `liveStreak` shows what that completion would find.
- The recap (`getRecap`) is read from the vote ledger for the last play day before today, so it keeps changing as votes settle; dismissal is stored per day on `KnightsPlayer`.
- A career reset moves `NewOrderPlayer.startAt`: a streak whose last Watch was completed before it is treated as 0 (shields kept), only votes cast since it count toward the Watch, and the recap ignores earlier votes. The gold cap still counts the whole UTC day.

## Conversion (`src/lib/server/conversion`)

Gold -> Buzz, the label pass and the tick's retries. `KNIGHTS_CONVERSION_ENABLED` (`conversionEnabled()`) is off by default; `/gold` refuses Convert unless it is exactly `true`. Apply by hand, in order: `20261213120000_knights_v2_progression`, `20261218120000_knights_v2_conversion`, deploy Knights, then the main app, then `20261223120000_knights_v2_drop_gold_clearing`. Detail: [`docs/features/knights-conversion.md`](../../docs/features/knights-conversion.md).

## Reference images and the apprenticeship (`src/lib/server/trials`, `src/lib/server/apprenticeship`)

Tables `KnightsReferenceImage`, `KnightsHarvestCursor` (migration `20261212120000_knights_v2_trials`, applied by hand) feed the Acolyte apprenticeship. Harvest knobs are in `trials/config.ts`.

- A reference image has a known `answer`, a `source` (`core` | `harvested`; `agreement`, from Templar/Paladin agreement, is a later source) and a `pool`. `imageId` is unique across modules on purpose: one known answer per image, and an image sits in `trials` or in `hiddenCheck`, never both. Core rows are curated in the moderator app, `/knights-of-new-order/trials` (own page grant; `apps/moderator/src/lib/server/knights/coreset.service.ts`), and need an `explanation`. `status` is `active` (served), `pending` (held for the blind spot-check, never served) or `retired`; the same page flags items by failure rate (`coreset.config.ts`).
- `POST /api/jobs/harvest` (`Authorization: Bearer $JOBS_TOKEN`) reads `ModActivity` rows `setNsfwLevel` on images past a cursor, no older than `maxRulingAgeDays`. It keeps an image only while the moderator ruling still stands and its image is still servable (`servableImage`; see `harvest.service.ts`). Images already present are skipped. It also retires fresh items older than `freshMaxAgeDays` or whose image moved. Safe to run repeatedly; schedule it daily. With `spotCheck` on, harvested Trials-pool items are inserted `pending` (hidden checks stay `active`) until a moderator re-rates them blind: the same rating makes them `active`, any other retires them, and an unchecked one retires with the other fresh items when it ages out.
- The apprenticeship (continuous graded stream of core, harvested and moderator yes/no references in `KnightsYesNoReference`; XP per right answer; Knight at level 20 with 75% over the last 100; recap every 20) is described in [`docs/features/knights-apprenticeship.md`](../../docs/features/knights-apprenticeship.md). Answers live in `KnightsApprenticeAnswer` (migration `20261225120000_knights_v2_apprenticeship`, by hand).
- Rank badges: apprenticeship promotion and the Progression rank-ups call `grantRankBadges` (`progression/badges.ts`), which inserts the original game's Knight (859) and Templar (860) Trophy cosmetics into `UserCosmetic` (ids are hardcoded in the main app's `newOrderConfig.cosmetics.badgeIds`; no table maps rank to cosmetic), once per player, best effort, and a skip to Paladin also grants the Templar badge (Paladin has no badge). It does not queue the user-search reindex the main app's `grantCosmetic` does. The v1 rank-up signal (`NewOrderPlayerUpdate`) is not sent. Level, streak and Founding Knight badges are not granted.
- `answers` and `failures` are per-item counters.

## Sources (queue producers)

The enqueue contract is `{ source, questionKey, items: [{ imageId, priority: 1|2|3, minRank?, votesNeeded?, expiresAt?, prediction? }] }`.
It is implemented once, in the main app: `src/server/services/knights/enqueue.service.ts` (`enqueueKnightsItems`, one batch insert).
Per item it answers `enqueued` | `duplicate` | `refused` (refusal reasons: see the result type in `enqueue.service.ts`). Defaults and the stage-rank rule match `enqueueItem` here; the stage ranks and TTL live in
`@civitai/shared/new-order`. An open, Inquisitor or Ruling item for the same question and image makes a new one a duplicate; the partial unique
index `KnightsQueueItem_open_question_image_key` (migration `20261211120000_knights_v2_sources`, applied by hand, with the `prediction` column) closes the race.

- `POST /api/mod/knights/enqueue` (`src/pages/api/mod/knights/enqueue.ts`): a moderator session or full-access API key that also holds the
  `knightsEnqueue` grant. Up to 1000 items per call; a 200 does not mean every item was queued, read `results`.
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

## Motion and sound (`src/global.css`, `src/motion.css`)

Tokens and easings are in `src/global.css`, keyframes in `src/motion.css`. Keep play-loop motion to 200ms or less and never gate a submit on it; every keyframe needs a reduced-motion counterpart; a new sound needs both files, `SOUND_NAMES` and `SOUND_LEVELS` entries and a `CREDITS.md` line. Detail: [`docs/features/knights-motion-and-sound.md`](../../docs/features/knights-motion-and-sound.md).

## Wired packages

`@civitai/auth` (guard), `@civitai/axiom` (logging), `@civitai/brand` (favicon), `@civitai/buzz` (gold conversion), `@civitai/db` + `@civitai/db-schema` (Kysely, one client),
`@civitai/flipt` (access flag), `@civitai/redis` (sys client: the guard's session revocation check, the skip sets, the leaderboard cache),
`@civitai/shared` (`NsfwLevel`; `new-order-levels` is the level curve, also used by the main app's `game-helpers.ts`). Add others when a task needs them.

## Tests

`pnpm --filter @civitai/knights-app test` (project `app:knights`). Typecheck with `typecheck`, never `check`.
