# Knights v2: hidden checks and smites

Both live in the Knights app (`apps/knights`). Smites use the main app's `NewOrderSmite` table and `resetPlayer`, so the original
game and the new one agree. Values are in `src/lib/server/hidden/config.ts` (set from the environment, see `.env.example`) and
`src/lib/server/smites/config.ts`. Migration `20261210120000_knights_v2_tables` (applied by hand; the `KnightsVote` consequence columns and `KnightsPlayer.startAtSeen`), plus `20261211120000_knights_v2_smite_active_target_idx` for the active-smite index on `NewOrderSmite`.

## Hidden checks (`src/lib/server/hidden`)

Players never see the mechanism: a graded check reads as the Order's ruling ("⚠️ The Order disagrees", "⚡ You have been
smote", "≈ A near judgment", naming the Order's answer and the player's), and player-facing copy never says "skill check"
(`src/lib/player-copy.test.ts`). The code, tables and config keep the name "hidden check". A smite's stored reason is
`SMITE_REASON` ("The Order found a judgment false."); smites issued before 2026-11-17 carry "You failed a skill check. A smite
penalty has been applied and cost you a heart.", so anything matching these smites by reason must match both.

Known-answer images (`KnightsReferenceImage`, pool `hiddenCheck`) served in a Knight's feed beside queue items. A check is an
ordinary vote in every way a player can see.

- Where checks come from: the ruling harvest (`trials/harvest.service.ts`) sends new rulings to `trials` unless
  `KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE` sends a share to `hiddenCheck`, and skips rulings from the moderator image queue.
  `KNIGHTS_HARVEST` set to anything but unset, `on`, `true` or `1` (or "Paused" saved on the Config page, which wins over
  the variable, as a saved share wins over `KNIGHTS_HARVEST_HIDDEN_CHECK_SHARE`; see
  [game settings](knights-sources.md#game-settings)) pauses intake (the cursor holds) while references
  whose ruling no longer stands are still retired. Rulings that aged past the window during a pause are skipped, logged and
  counted (`knights_harvest_skipped_rulings_total`). A retired reference keeps its image, so that image is never harvested again; an `agreement` reference that never graded anyone is the exception, since a moderator ruling replaces it.
- `pnpm run rebuild:hidden-checks` (`trials/hidden-rebuild.service.ts`) retires every live harvested check that fewer than
  `KEEP_MIN_PLAYERS` players answered or that most of its players answered differently, plus any `--exclude` image ids.
  It changes only `status`, never deletes, and is a dry run without `--apply` (local database only). For a run
  elsewhere, `--print-sql` prints the SELECT of the ids to retire, and `--print-sql --ids <ids>` a transaction that retires exactly
  those ids and commits only if it retired all of them, both with their values written in. `--pool trials` retires
  active harvested `trials` references by the same rule, counting the Acolytes' apprenticeship answers instead of Knight
  votes; it leaves pending ones, which wait for a moderator spot-check, alone.
- Probation (`trials/agreement-intake.service.ts`, `trials/probation.service.ts`, both run by the harvest job): while the
  probation share is above 0, agreed Knight-stage verdicts are taken in as `probation` checks (source `agreement`), a
  bounded number per level bucket. A probation check grades nobody. Once enough independent players have answered it, the
  review promotes it to `active` or retires it; the review runs even while the harvest is paused. Active checks are not
  reviewed this way. The rules live in those two services.
- Mod-confirmed checks (`skill-check/pool.ts`, pool `skillCheck`, source `inquisitor`): an image two moderators gave the same
  level in the [in-game inquisitor queue](knights-inquisitor.md) becomes a check at that level, served to Acolytes and Knights
  alike. An image already in another pool moves here with its counters reset; a core trial image never moves. The pool keeps
  `skillCheckPoolCap` active checks (Config page, default 500) and retires the oldest when a new one comes in. An image under
  a review or hold never enters, checked again at every serve (`skill-check/eligible.ts`): the shared legal-hold and
  reported-image predicates and the shared CSAM-signal and unscanned predicates (`@civitai/shared/held-media`, `held-url`: the
  image, and its owner's account), evidence holds, open reports on the image, its post, a model it was made with or its owner,
  appeals and scan holds, prompt flags, an open Inquisitor item, a banned or muted uploader, and a model flagged as depicting
  a minor or a real person. A check that cannot be read keeps the image out (fail closed): the serve skips the pool rather than
  failing. The pool is served only while the inquisitor queue is switched on. These checks have no age limit; they leave by the cap, by Knights' own
  failures (below), or when a moderator moves the image off their level (the harvest job's stale sweep).

- The draw (`pickHiddenCheck`) is balanced across level buckets: each bucket (the reference's `answer`: PG, PG-13, R, X,
  XXX, with any other answer as a group of its own) that still has a check the player can take is equally likely, whatever
  its size, so a mostly-PG pool does not mean mostly-PG checks. Inside the bucket it takes the first eligible check from a
  per-player point in the pool's id range. Whether a slot holds a check at all is the same rate roll as before
  (a rate saved on the moderator Config page, else `KNIGHTS_HIDDEN_CHECK_RATE`; every `KNIGHTS_HIDDEN_CHECK_*` setting
  but the probation share works this way, see [game settings](knights-sources.md#game-settings)). The bucket order, start point and roll all come from one per-player digest (no random
  numbers), so the same player and slot always get the same offer. A second digest from the same seed picks whether
  probation or active checks are tried first (`KNIGHTS_HIDDEN_CHECK_PROBATION_SHARE`, environment only, default 0: never
  probation), taking the other when the first has none for the player.
- Every feed item, check or queue item, is addressed by a sealed token (`feed-token.ts`, key `FEED_TOKEN_SECRET`). The vote action
  opens the token and routes to `castVote` or `answerHiddenCheck`.
- Both write the same `KnightsVote` row through `insertVote` and `creditVote` (`queue/vote-record.ts`), so XP, pending gold, the
  daily tally, pacing, `/judgments` and the status line treat them alike. A check has no queue item: its ledger `itemId` is the
  negative of its reference image's id, so write-back, consensus and the queue sweeps never see it, and it is stored as already
  labelled so the label pass skips it.
- A check answered on `/play` is graded in the same request (`answerHiddenCheck` with `grade`, through `gradeHiddenVotes`), then
  paid through the same `payOutVotes` as a settled queue vote: a right answer earns gold and bulk XP and works smites off, a wrong
  one drops its gold. Accuracy counts the check from then. The action returns the outcome (`check`: verdict, warning or smite,
  active smites, whether it reset the career), and the page reads its data again after the vote, so the notice shows at once.
  `settleHiddenChecks` (run by the tick) is now only the sweep for checks still pending after `settleDelayMinutes`, such as ones
  answered before inline grading shipped. Grading on the spot shows which images were checks; that is accepted because a player is
  never served a check on an image they already voted on (unless `skillCheckServeJudged` is on, for mod-confirmed checks
  only; the same check is never served twice), and the harvest and the inquisitor queue keep renewing the pool. The draw reads
  the `hiddenCheck` and `skillCheck` pools together.
- An exact match is correct. A rating one level from the known answer, on either side (`isCloseAnswer`, `levelDistance` = 1;
  Blocked is not a level, so Blocked against the top level is a miss) is **close**: graded `inconclusive` for the player (no
  payout, no warning, no smite, not in accuracy, not an earlier failure for the warning rule) and marked `consequence = 'close'`,
  so the notice ("≈ A near judgment") and `/judgments` say it was close and name the known answer. Two or more levels off is failed as
  before. Tick and inline grading share this through `gradeHiddenVotes`.
- Grading counts the answer on its reference image (`answers`, `failures`); a close answer counts as a miss there, so a
  borderline reference still retires. A harvested check failed by more than
  `KNIGHTS_HIDDEN_CHECK_RETIRE_FAILURE_RATE` (default 0.5) of at least `KNIGHTS_HIDDEN_CHECK_RETIRE_MIN_ANSWERS` (default 20)
  answers is retired in the same transaction: its known answer is more likely wrong or unclear than its players in bad faith.
  The harvest never re-adds a retired image (`imageId` is unique).
  A mod-confirmed check skips that shared-counter rule, since Acolytes' exact-match misses land on the same counters; it
  retires when Knights' graded answers in the ledger (correct or failed; close answers are inconclusive) pass the same two
  thresholds, counting only answers since the check entered the pool (`knights_skill_checks_retired_total{reason="failures"}`).
  A check whose answers were already graded at another level is never moved into the mod-confirmed pool.
  A check still pending when its reference is retired (by this rule or by hand) is graded `inconclusive`: no pay, no penalty.
- A wrong answer can cost the player a warning or a smite, decided when the check is graded: the first failure (a `warning`
  or `smite` consequence, never `close`) in `failureWindowHours` is a warning, each later one (or a severe under-rating) a smite, one check at a time. It is stored on the
  vote (`consequence`) and shown as a notice that the player dismisses (only a notice from the current career, since `startAt`; a
  career reset leaves the old one behind) (`readHiddenNotices`, `dismissHiddenNotices`). There is one notice per check, newest
  first (at most 5), with the image's thumbnail (when still servable), the answer given and the answer the check wanted; reading
  never changes anything, so a preload cannot lose it. `/judgments` names the known answer on a wrong check too.

## Smites (`src/lib/server/smites`)

- Smites live in the shared `NewOrderSmite` table; `voteWeight` already reads them.
- A skill-check smite has size 25 (`SMITES.size`; the original game used 100): each correct vote settled by `payOutVotes` works
  every active smite down by one, counted per vote even when one settlement pays several (`workOffSmites(…, total.correct)`), and
  a smite at 0 is cleansed. The tick lapses old ones (`expireSmites`) under the same player-row lock order, never for a player
  whose reset is due.
- Progress shows to the player: `PlayerStatus.heartBack` (`heartBackOf`, the active smite with the fewest left) feeds the hearts'
  tooltip, the rail ("12/25 to the next"), the home page's smite card and the Codex; a right skill-check answer while a smite is
  active shows a "+1 toward your next heart" cue on `/play`.
- Reset: the Knights app calls the main app's `POST /api/mod/knights/reset-player` (`x-webhook-token`), naming its smite limit.
  The endpoint reuses the single `resetPlayer` under a per-player lock and is safe to repeat. If the call fails the active smites
  are the pending record: `insertVote` refuses (`reset-pending`) and the tick retries (`resetPendingPlayers`) before it expires smites.
- Notice: a reset moves `NewOrderPlayer.startAt`; `/play` (the Acolyte apprenticeship included) shows a notice while `startAt` is later than
  `KnightsPlayer.startAtSeen`, until dismissed. A player's first look only records where they stand.

## Acolytes

Acolytes get no hidden checks: every apprenticeship item already has a known answer, so every answer is a check. Six wrong among an Acolyte's last 20 answers issue a smite, a level-up clears them, and three make the career reset due. Details: [`knights-apprenticeship.md`](knights-apprenticeship.md#smites).
