# Knights queue sources

Moved from `apps/knights/CLAUDE.md`. The enqueue contract lives in the main app: `src/server/services/knights/enqueue.service.ts`.

The enqueue contract is `{ source, questionKey, items: [{ imageId, priority: 1|2|3, minRank?, votesNeeded?, expiresAt?, prediction? }] }`.
It is implemented once, in the main app: `src/server/services/knights/enqueue.service.ts` (`enqueueKnightsItems`, one batch insert).
Per item it answers `enqueued` | `duplicate` | `refused` (refusal reasons: see the result type in `enqueue.service.ts`). Defaults and the stage-rank rule match `enqueueItem` here; the stage ranks and TTL live in
`@civitai/shared/new-order`. An open, Inquisitor or Ruling item for the same question and image makes a new one a duplicate; the partial unique
index `KnightsQueueItem_open_question_image_key` (migration `20261210120000_knights_v2_tables`, applied by hand, which also has the `prediction` column) closes the race.

- `POST /api/mod/knights/enqueue` (`src/server/api-routes/mod/knights/enqueue.ts`): a moderator session or full-access API key that also holds the
  `knightsEnqueue` grant. Up to 1000 items per call; a 200 does not mean every item was queued, read `results`. Unlike the producers below, it also refuses images Knights may not show (`not-servable`: `servableImage` in `@civitai/db/knights`: published, rated, no block marker or review hold, not flagged poi/minor).
- The image-scan pipeline (`scan-sample`: safe-looking priority 1, NSFW priority 2) and an owner's own rating (`owner-rating`, priority 1) also enqueue
  here, beside today's game, which is untouched. Both pass `requirePublished`: an image with no post is refused (`no-post`), and so is one whose post is
  a draft or scheduled for later (`unpublished`), which the publish sweep below samples once the post goes live, at the sampling rates (an owner
  rating there gets no item of its own). An owner rating on a video is refused too (`not-still-image`; the scan hook only ever passes still
  images). Both hooks live in `src/server/services/knights/sources.ts`, never throw into the scan, and are
  **off unless** the sys Redis key `system:knights-v2-sources` (`REDIS_SYS_KEYS.SYSTEM.KNIGHTS_V2_SOURCES`) holds
  `{"enabled":true,"sfwRate":1,"nsfwRate":0.3}`; a missing or unreadable key means off, rates are 0-1 samples per pool. Set it in sys Redis; no
  deploy needed.
- Sampling happens once the post is live. A scan result samples its image only when the post is already published (`publishedAt` set and not in
  the future; otherwise `unpublished`). Posts that go live later are sampled by the `knights-publish-sampling` job
  (`src/server/jobs/knights-publish-sampling.ts`, every minute; `sampleNewlyLivePostsForKnights` in `src/server/services/knights/sampling.ts`):
  it reads posts published after its cursor and up to a minute ago, whatever set `publishedAt` (an owner's publish, a scheduled date
  arriving, a model, version or collection publish), at most 200 per run in `(publishedAt, id)` order, so posts sharing one instant drain
  across runs. It also re-reads the posts published in the 15 minutes behind its cursor (up to 2000), since a scheduled publish stamps the
  scheduled time and an owner's publish stamps before it commits, so a post can land behind a cursor that has passed it. Never more than six
  hours back. Their scanned still images (`servableImageContent` in `@civitai/db/knights`) go through the same enqueue and rates as a scan
  sample, with the same `scan-sample` source; an image not scanned yet is left to its scan. The SFW/NSFW split there is `Image.nsfwLevel`
  above the SFW levels, as the scan splits it. The cursor (`{ publishedAt, postId }`) is a `KeyValue` row, `knights-publish-sampling:cursor`,
  stored only after a run completes; a run that could not read the sources switch in time stores nothing, so the window is retried, while
  a switch that is off moves the cursor on.
- Each image is sampled at most once (`oncePerImage`): an image that ever had a rating item, in any status, is not queued again by either
  sampler, so a rescan or a republished post never re-queues it (a republish restores the old `publishedAt`, outside the job's window
  anyway). The draw is fixed per image (`knightsSampleDraw`, a hash of the image id compared with the pool's rate), so a scan and the job,
  or two overlapping runs, decide the same way; raising a rate admits images an earlier draw left out. The moderator enqueue endpoint keeps
  the open-item duplicate rule.
- Backpressure: the optional `maxOpen` field (a whole number, default 5000 when missing or unusable) pauses **sampling only** (scan and publish) while more
  than that many rating items players can be served are open at the Knight stage (`countOpenServableKnightItems` in `@civitai/db/knights`: items whose image is a draft, scheduled, deleted, held, or flagged poi/minor cannot be judged and do not count; yes/no questions share the queue table but are not counted either). Owner ratings always enqueue. The main app counts them up to
  `maxOpen + 1` on the `(status, minRank, ...)` index and caches the count in process for 60 s. One count runs at a time; a scan waits at
  most 500 ms for it and is not throttled when it is slower, and the count still fills the cache when it lands. A failed count does not
  throttle, is not cached, and pauses counting for 10 s. The publish job counts once per run instead, uncached, after dropping images that
  already had an item, and queues at most as many as keep the count within `maxOpen`; the rest are dropped as a capped scan is, and a failed
  count fails the run, which the next run retries. The moderator Config page edits the three fields above, the open-item cap `maxOpen` (a blank box keeps the stored cap; whole
  numbers up to `KNIGHTS_SOURCES_MAX_OPEN_LIMIT`), and the optional
  `yesNoShare` (0-1, Knights' yes/no question share, see [yes/no questions](knights-yesno-questions.md)); a save there keeps the stored game settings, and keeps a stored `yesNoShare` when its box is left blank. Its "Reset" button
  removes a stored `yesNoShare` (audited like any save), so Knights falls back to `KNIGHTS_YESNO_SHARE`. The same page edits
  the [game settings](#game-settings).
- Inquisitor queue: moderator app `/knights-of-new-order/inquisitor` (own page grant), tabbed Blocked, Pushed down and Write-back conflict; a rating with no consensus never comes here, Knights re-rates it ([queue escalation](knights-queue-escalation.md#rule-4-a-split-at-the-end-of-the-path-is-re-rated)). A moderator's rating goes through the moderator app's
  `updateImageNsfwLevel` (activity `setNsfwLevel`), the item closes (`moderator-ruled`) and its pending votes are graded against that level, Blocked included.
  A triage page: J/K move, 1 to 5 rate PG to XXX, 6 is Blocked, which asks for a reason from the Knights' list (`KNIGHTS_BLOCK_REASONS`, picked by
  digit) and records it on the image as `metadata.nsfwLevelReason` (`Inquisitor ruling: <reason>`); other levels record no reason.
- Dev queue: with the migration applied to your local database, `cd apps/knights && pnpm run dev:enqueue-recent [count]` enqueues the newest eligible
  images (scanned, unlocked, and servable: published, level not 0 or Blocked, no block marker, no review hold; default 50, max 1000) as source `dev-backfill`. It reads `DATABASE_URL` from
  `apps/knights/.env`, is safe to repeat, and refuses to run unless the host is `localhost` or `127.0.0.1`.

## Game settings

The game-tuning variables Knights read from its environment can also be saved under the optional `game` object of the same
`system:knights-v2-sources` key (no new key; the main app ignores it). Fields, each overriding the variable named:
`hiddenCheckRate` (`KNIGHTS_HIDDEN_CHECK_RATE`, 0-1, 0 stops serving skill checks), `hiddenCheckFailureWindowHours` (`>0`),
`hiddenCheckSevereDistance` (whole number `>0`), `hiddenCheckSettleDelayMinutes` (`>=0`), `hiddenCheckRetireMinAnswers` (whole number
`>0`), `hiddenCheckRetireFailureRate` (`>0` to 1), `yesNoStretch` (whole number `>0`), `yesNoMaxAgeDays` (`>0`), and the booleans
`apprenticeSmites` (`KNIGHTS_APPRENTICE_SMITES`), `shopDisabled` (`KNIGHTS_SHOP_DISABLED`), `conversionDisabled`
(`KNIGHTS_CONVERSION_DISABLED`) and `signalsDisabled` (`KNIGHTS_SIGNALS_DISABLED`, [live updates](knights-live-updates.md)), plus the harvest's `harvest` (boolean, true runs it; overrides `KNIGHTS_HARVEST`, which without a
saved value runs the harvest when unset, `on`, `true` or `1`) and `harvestHiddenCheckShare` (`KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE`, 0-1).
The harvest job reads both per run. The [in-game inquisitor](knights-inquisitor.md) pool adds `skillCheckPoolCap`
(`KNIGHTS_SKILL_CHECK_POOL_CAP`, whole number `>0`, default 500: mod-confirmed checks kept, oldest retired first) and the boolean
`skillCheckServeJudged` (`KNIGHTS_SKILL_CHECK_SERVE_JUDGED`, default off: a player may be served a mod-confirmed check on an image
they already judged or answered as an Acolyte). The switch for the whole feature is the boolean `inquisitorQueue` (`KNIGHTS_INQUISITOR_QUEUE`, default off). The list, its ranges (the same as the Knights environment readers) and the reader are
`KNIGHTS_GAME_SETTINGS` / `readKnightsSourcesConfig` in `@civitai/shared/new-order`; a stored field that is out of range is dropped
on read, so that setting falls back to the environment.

Knights reads them, with `yesNoShare`, through one cached source (`apps/knights/src/lib/server/settings`), at most every 30 s:

- a saved value wins over the environment;
- a read that fails or takes over 400 ms keeps the last value read;
- before any good read, the environment (then the built-in default) applies;
- a read that succeeds but finds the key absent, empty or unreadable (not JSON, not an object) counts as nothing saved: every
  setting falls back to the environment at once. Only a failed read keeps the last value.

The two kill switches follow the same rule, so a store outage never flips the shop or conversion away from the last known state.

The moderator Config page (`/knights-of-new-order/config`) is one column: the queue counts, then cards for Queue sources (switch,
both rates, yes/no share), Skill checks, Yes/no questions, Acolytes, Harvest, and a "Shop and conversion" danger-zone card. Each
setting with a Knights default carries a "Default" or "Custom" badge (its tooltip names the variable behind the default), and a
custom number has a "Reset" button that removes the saved value. Toggles are segmented with the default first and positive labels:
Shop Default / Open / Closed, Gold to Buzz conversion Default / On / Off, Acolyte wrong-answer smites Default / On / Off, Harvest
Default / Running / Paused (no confirmation), stored as the same booleans. A sticky bar counts unsaved changes and saves them through the page's two
actions (`?/save` for the sources, `?/game` for the game settings, each only when its fields changed); Discard restores what is
stored. The game form posts only the changed fields; `saveGameSettings`
(`apps/moderator/src/lib/server/knights/sources-config.service.ts`) applies them over what is stored, carries every other field over
(switch, rates, `maxOpen`, `yesNoShare`, other game settings), refuses an out-of-range or mistyped value without coercing it, and
writes and audits through the same path as the sources form (`ModActivity`, `knights.sources.update`, with before and after).
The moderator app is the only writer of the key. Every save is a compare-and-set: it writes only if the key still holds what it
read, otherwise it reads again and reapplies its change, up to three times, then refuses with "Another moderator saved the config
at the same time", so two saves never overwrite each other. A
change to either kill switch is refused unless confirmed; the page asks in a dialog before saving one, or before turning the sources
on. The last recorded change is under "Recent changes" at the bottom.
