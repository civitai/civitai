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
  override on the item wins. `minRank` must be a stage rank (Knight, Templar, Paladin); anything else throws.
- `getFeed`: open items the player's rank may judge, higher stages first, then priority and age, from the first
  question in that order. Which ranks may judge a stage is `canVote` in `ranks.ts`, shared with `castVote`; Inquisitors
  and Acolytes get no feed. It never selects the image's rating. Hidden checks are not served yet (no grader).
  Only images the public feeds would show are served (`servableImage`, `src/lib/server/servable-image.ts`, shared with `getFeed`, `castVote`, Trials, the harvest and the dev script): an image-type, published post, level not 0 or Blocked, no block marker, no review hold.
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
- The vote ledger is partitioned by month. `POST /api/jobs/partitions` creates the next months and a vote creates its
  own month if missing; `POST /api/jobs/tick` also escalates items past `expiresAt` and settles votes on final items (`settledVotes` in its response; any failing step, or an item that could not be settled, returns 500). Both need
  `Authorization: Bearer $JOBS_TOKEN`.
- The user guard in `hooks.server.ts` skips exactly the routes in `JOB_PATHS` (tick, partitions, harvest, notify); a new job route must be added there.
- `/play` is the minimal voting page, with a status line (rank, level and XP from `@civitai/shared/new-order-levels`, the trial position for Acolytes, and the progression standing described under Progression). Acolytes, and players with no `NewOrderPlayer` row yet, get Trials instead of the feed and cannot vote; Knights and above keep the feed. It also shows the Daily Watch panel and the dismissable recap (see Daily loop); `/ranks` lists each rank's daily gold cap.

## Progression (`src/lib/server/progression`)

Migration `20261213120000_knights_v2_progression` (applied by hand): `KnightsVote.xp` / `settledAt`, `NewOrderPlayer.goldPending` / `goldEarned`. Progression amounts are in `progression/config.ts`; the Watch, streak and shield amounts are in `daily/config.ts` and the per-rank daily gold cap is in `ranks.ts` (see Daily loop).

- A vote pays flat XP at once and records `gold` as pending on the vote and in `goldPending`: base x the voter's rank multiplier x `RATING.belowBarFactor` while below the bar, then clamped to what is left of the rank's daily cap (see Daily loop). A clamped vote records the clamped amount, so settling drops or keeps only that.
- `settleItemVotes` pays a graded item once, only when its outcome is final (`Closed`, or `Resolved` and written back): correct = bulk XP, gold moves pending -> earned; wrong or inconclusive = gold dropped. `settledAt` plus the row lock make it idempotent. It runs in the transaction of every Knights path that finalises an item, and `POST /api/jobs/tick` sweeps (`settleFinalItems`) what other apps closed (the moderator app's rulings).
- Fervor is computed from the ledger (the player's last `fervorWindow` settled correct/failed votes since `startAt`, inconclusive excluded); the status line reads it from there and settle also writes the `fervor` column. A vote cast before a `startAt` reset settles without paying.
- Ranks: `progression/rating.ts`, knobs in `config.ts` (`RANK_LADDER`, `RATING`). Accuracy shares fervor's `ledgerOf` window and is "not yet rated" below `RATING.minGraded`.
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

## Notifications (`src/lib/server/notify`)

Table `KnightsNotificationSend` (migration `20261217120000_knights_v2_notify`, applied by hand, before the job first runs). `POST /api/jobs/notify` (`Authorization: Bearer $JOBS_TOKEN`; schedule it hourly, so the 21:00 UTC warning goes out within the hour) sends through `@civitai/notifications`; env `NOTIFICATIONS_ENDPOINT` / `NOTIFICATIONS_TOKEN`.

- Three opt-in types, registered in the main app (`src/server/notifications/new-order.notifications.ts`, section "Knights of New Order"): `knights-verdicts-in` > `knights-streak-ends-soon` > `knights-new-images`. A player gets the best one they are eligible for and subscribed to, at most one per UTC day.
- Opt-in means a `UserNotificationSettings` row for the type. The job joins that table itself and sends through the client's bulk path, which does no settings lookup (the event path would drop exactly the subscribers). The three processors are `externalProducer` for that reason.
- Verdicts: votes settled (correct or failed) within `verdictLookbackDays`, after the player's newest vote and after their last verdicts notification. Streak: a live streak after the career-reset rule, no Watch yet today, and no shield covering the miss (the `streak.ts` functions the status line uses); sent from `streakWarningHourUtc`. New images: a voting rank with a servable queue item the player has not voted on. Before the warning hour a player with a streak at risk is held back from new images, so the warning keeps the day's slot.
- A send claims the player's `(playerId, day)` row first (primary key), then sends; a batch that fails gives its claims back, so a rerun the same day neither double-sends nor loses it. Messages are the same for everyone in a batch, so they carry no per-player numbers.

## Trials (`src/lib/server/trials`)

Tables `KnightsReferenceImage`, `KnightsTrialRun`, `KnightsTrialAnswer`, `KnightsHarvestCursor` (migration `20261212120000_knights_v2_trials`, applied by hand). All knobs and their defaults are in `trials/config.ts`.

- A reference image has a known `answer`, a `source` (`core` | `harvested`; `agreement`, from Templar/Paladin agreement, is a later source) and a `pool`. `imageId` is unique across modules on purpose: one known answer per image, and an image sits in `trials` or in `hiddenCheck`, never both. Hidden checks are not served yet. Core rows are curated elsewhere (moderator app, later) and need an `explanation`.
- `POST /api/jobs/harvest` (`Authorization: Bearer $JOBS_TOKEN`) reads `ModActivity` rows `setNsfwLevel` on images past a cursor, no older than `maxRulingAgeDays`. It keeps an image only while the moderator ruling still stands and its image is still servable (`servableImage`; see `harvest.service.ts`). Images already present are skipped. It also retires fresh items older than `freshMaxAgeDays` or whose image moved. Safe to run repeatedly; schedule it daily.
- A run is per question key (`TRIAL_MODULES`; only `knights.image.nsfwLevel`), seeded per player: `seed` and the planned `itemIds` are stored on the run. It opens with core items, then fresh ones, which never repeat for that player. One open run per player and module.
- After each answer the page shows right or wrong, the correct level and, for core items, the explanation.
- The score counts fresh items only, and only when at least `minFresh` were answered. `score >= passMark` passes; passing every module since the player's last `NewOrderPlayer.startAt` (a reset moves it) sets `rankType` to Knight. Failing sets `cooldownUntil`; the next run gets a new seed. A run with too few answered fresh items (images became unservable) closes `void`: no score, no cooldown, and a new run starts.
- The Knight badge award (and the rank-up signal) the v1 promotion sends is not wired yet, for Trials promotion and for the Progression rank-ups alike.
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

## Wired packages

`@civitai/auth` (guard), `@civitai/brand` (favicon), `@civitai/db` + `@civitai/db-schema` (Kysely, one client),
`@civitai/flipt` (access flag), `@civitai/redis` (sys client, only for the guard's session revocation check),
`@civitai/shared` (`NsfwLevel`; `new-order-levels` is the level curve, also used by the main app's `game-helpers.ts`). Add others when a task needs them.

## Tests

`pnpm --filter @civitai/knights-app test` (project `app:knights`). Typecheck with `typecheck`, never `check`.
