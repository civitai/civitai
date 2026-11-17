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
- Backpressure: the optional `maxOpen` field (a whole number, default 5000 when missing or unusable) pauses **scan sampling only** while more
  than that many rating items are open at the Knight stage (yes/no questions share the queue table but are not counted). Owner ratings always enqueue. The main app counts open Knight-stage rating items up to
  `maxOpen + 1` on the `(status, minRank, ...)` index and caches the count in process for 60 s. One count runs at a time; a scan waits at
  most 500 ms for it and is not throttled when it is slower, and the count still fills the cache when it lands. A failed count does not
  throttle, is not cached, and pauses counting for 10 s. The moderator Config page edits the three fields above and the optional
  `yesNoShare` (0-1, Knights' yes/no question share, see [yes/no questions](knights-yesno-questions.md)); a save there keeps a stored
  `maxOpen` and the stored game settings, and keeps a stored `yesNoShare` when its box is left blank. Its "use the Knights default"
  checkbox removes a stored `yesNoShare` (audited like any save), so Knights falls back to `KNIGHTS_YESNO_SHARE`. The same page edits
  the [game settings](#game-settings).
- Inquisitor queue: moderator app `/knights-of-new-order/inquisitor` (own page grant). A moderator's rating goes through the moderator app's
  `updateImageNsfwLevel` (activity `setNsfwLevel`), the item closes (`moderator-ruled`) and its pending votes are graded against that level, Blocked included.
- Dev queue: with the migration applied to your local database, `cd apps/knights && pnpm run dev:enqueue-recent [count]` enqueues the newest eligible
  images (scanned, unlocked, and servable: published, level not 0 or Blocked, no block marker, no review hold; default 50, max 1000) as source `dev-backfill`. It reads `DATABASE_URL` from
  `apps/knights/.env`, is safe to repeat, and refuses to run unless the host is `localhost` or `127.0.0.1`.

## Game settings

The game-tuning variables Knights read from its environment can also be saved under the optional `game` object of the same
`system:knights-v2-sources` key (no new key; the main app ignores it). Fields, each overriding the variable named:
`hiddenCheckRate` (`KNIGHTS_HIDDEN_CHECK_RATE`, 0-1, 0 stops serving skill checks), `hiddenCheckFailureWindowHours` (`>0`),
`hiddenCheckSevereDistance` (whole number `>0`), `hiddenCheckSettleDelayMinutes` (`>=0`), `hiddenCheckRetireMinAnswers` (whole number
`>0`), `hiddenCheckRetireFailureRate` (`>0` to 1), `yesNoStretch` (whole number `>0`), `yesNoMaxAgeDays` (`>0`), and the booleans
`apprenticeSmites` (`KNIGHTS_APPRENTICE_SMITES`), `shopDisabled` (`KNIGHTS_SHOP_DISABLED`) and `conversionDisabled`
(`KNIGHTS_CONVERSION_DISABLED`). The list, its ranges (the same as the Knights environment readers) and the reader are
`KNIGHTS_GAME_SETTINGS` / `readKnightsSourcesConfig` in `@civitai/shared/new-order`; a stored field that is out of range is dropped
on read, so that setting falls back to the environment.

Knights reads them, with `yesNoShare`, through one cached source (`apps/knights/src/lib/server/settings`), at most every 30 s:

- a saved value wins over the environment;
- a read that fails or takes over 400 ms keeps the last value read;
- before any good read, the environment (then the built-in default) applies;
- a read that succeeds but finds the key absent, empty or unreadable (not JSON, not an object) counts as nothing saved: every
  setting falls back to the environment at once. Only a failed read keeps the last value.

The two kill switches follow the same rule, so a store outage never flips the shop or conversion away from the last known state.

The moderator Config page (`/knights-of-new-order/config`, "Game settings") groups them as Skill checks, Yes/no, Acolytes, and Shop
and conversion. Each number field says whether it is saved there or on the Knights default, and a saved one has a "Use the
Knights default" checkbox that removes it. Each toggle is a three-way choice, "Knights default (env)" / On / Off, starting on
"Knights default" when nothing is saved (the moderator app cannot see the Knights environment); On or Off saves that value
explicitly, and "Knights default (env)" removes it. The form posts only the fields the moderator changed; `saveGameSettings`
(`apps/moderator/src/lib/server/knights/sources-config.service.ts`) applies them over what is stored, carries every other field over
(switch, rates, `maxOpen`, `yesNoShare`, other game settings), refuses an out-of-range or mistyped value without coercing it, and
writes and audits through the same path as the sources form (`ModActivity`, `knights.sources.update`, with before and after).
The moderator app is the only writer of the key. Every save is a compare-and-set: it writes only if the key still holds what it
read, otherwise it reads again and reapplies its change, up to three times, then refuses with "Another moderator saved the config
at the same time", so two saves never overwrite each other. A
change to either kill switch is refused unless confirmed; the page asks before saving one.
