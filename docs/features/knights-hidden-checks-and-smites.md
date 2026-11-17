# Knights v2: hidden checks and smites

Both live in the Knights app (`apps/knights`). Smites use the main app's `NewOrderSmite` table and `resetPlayer`, so the original
game and the new one agree. Values are in `src/lib/server/hidden/config.ts` (set from the environment, see `.env.example`) and
`src/lib/server/smites/config.ts`. Migration `20261210120000_knights_v2_tables` (applied by hand; the `KnightsVote` consequence columns and `KnightsPlayer.startAtSeen`), plus `20261211120000_knights_v2_smite_active_target_idx` for the active-smite index on `NewOrderSmite`.

## Hidden checks (`src/lib/server/hidden`)

Players see these as "skill checks"; the code, tables and config keep the name "hidden check".

Known-answer images (`KnightsReferenceImage`, pool `hiddenCheck`) served in a Knight's feed beside queue items. A check is an
ordinary vote in every way a player can see.

- The draw (`pickHiddenCheck`) is balanced across level buckets: each bucket (the reference's `answer`: PG, PG-13, R, X,
  XXX, with any other answer as a group of its own) that still has a check the player can take is equally likely, whatever
  its size, so a mostly-PG pool does not mean mostly-PG checks. Inside the bucket it takes the first eligible check from a
  per-player point in the pool's id range. Whether a slot holds a check at all is the same rate roll as before
  (`KNIGHTS_HIDDEN_CHECK_RATE`). The bucket order, start point and roll all come from one per-player digest (no random
  numbers), so the same player and slot always get the same offer.
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
  never served a check on an image they already voted on, and the harvest keeps renewing the pool.
- A wrong answer can cost the player a warning or a smite, decided when the check is graded: the first failure in
  `failureWindowHours` is a warning, each later one (or a severe under-rating) a smite, one check at a time. It is stored on the
  vote (`consequence`) and shown as a notice that the player dismisses (only a notice from the current career, since `startAt`; a
  career reset leaves the old one behind) (`readHiddenNotices`, `dismissHiddenNotices`). There is one notice per check, newest
  first (at most 5), with the image's thumbnail (when still servable), the answer given and the answer the check wanted; reading
  never changes anything, so a preload cannot lose it. `/judgments` names the known answer on a wrong check too.

## Smites (`src/lib/server/smites`)

- Smites live in the shared `NewOrderSmite` table; `voteWeight` already reads them.
- Cleansing: correct votes settled by `payOutVotes` work smites off, and the tick lapses old ones (`expireSmites`) under the same
  player-row lock order, never for a player whose reset is due.
- Reset: the Knights app calls the main app's `POST /api/mod/knights/reset-player` (`x-webhook-token`), naming its smite limit.
  The endpoint reuses the single `resetPlayer` under a per-player lock and is safe to repeat. If the call fails the active smites
  are the pending record: `insertVote` refuses (`reset-pending`) and the tick retries (`resetPendingPlayers`) before it expires smites.
- Notice: a reset moves `NewOrderPlayer.startAt`; `/play` (the Acolyte apprenticeship included) shows a notice while `startAt` is later than
  `KnightsPlayer.startAtSeen`, until dismissed. A player's first look only records where they stand.

## Acolytes

Acolytes get no hidden checks: every apprenticeship item already has a known answer, so every answer is a check. Six wrong among an Acolyte's last 20 answers issue a smite, a level-up clears them, and three make the career reset due. Details: [`knights-apprenticeship.md`](knights-apprenticeship.md#smites).
