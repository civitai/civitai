# Knights v2: hidden checks and smites

Both live in the Knights app (`apps/knights`). Smites use the main app's `NewOrderSmite` table and `resetPlayer`, so the original
game and the new one agree. Values are in `src/lib/server/hidden/config.ts` (set from the environment, see `.env.example`) and
`src/lib/server/smites/config.ts`. Migration `20261219120000_knights_v2_smites` (applied by hand).

## Hidden checks (`src/lib/server/hidden`)

Known-answer images (`KnightsReferenceImage`, pool `hiddenCheck`) served in a Knight's feed beside queue items. A check is an
ordinary vote in every way a player can see.

- Every feed item, check or queue item, is addressed by a sealed token (`feed-token.ts`, key `FEED_TOKEN_SECRET`). The vote action
  opens the token and routes to `castVote` or `answerHiddenCheck`.
- Both write the same `KnightsVote` row through `insertVote` and `creditVote` (`queue/vote-record.ts`), so XP, pending gold, the
  daily tally, pacing, `/judgments` and the status line treat them alike. A check has no queue item: its ledger `itemId` is the
  negative of its reference image's id, so write-back, consensus and the queue sweeps never see it, and it is stored as already
  labelled so the label pass skips it.
- `settleHiddenChecks` (run by the tick) grades a check against the known answer after a delay, then pays it through the same
  `payOutVotes` as a settled queue vote: a right answer earns gold and bulk XP and works smites off, a wrong one drops its gold.
  Accuracy counts the check only from then.
- A wrong answer can cost the player a warning or a smite, decided when the check is graded. It is stored on the vote
  (`consequence`) and shown as a notice that the player dismisses (`readHiddenNotices`, `dismissHiddenNotices`); reading never
  changes anything, so a preload cannot lose it.

## Smites (`src/lib/server/smites`)

- Smites live in the shared `NewOrderSmite` table; `voteWeight` already reads them.
- Cleansing: correct votes settled by `payOutVotes` work smites off, and the tick lapses old ones (`expireSmites`) under the same
  player-row lock order, never for a player whose reset is due.
- Reset: the Knights app calls the main app's `POST /api/mod/knights/reset-player` (`x-webhook-token`), naming its smite limit.
  The endpoint reuses the single `resetPlayer` under a per-player lock and is safe to repeat. If the call fails the active smites
  are the pending record: `insertVote` refuses (`reset-pending`) and the tick retries (`resetPendingPlayers`) before it expires smites.
- Notice: a reset moves `NewOrderPlayer.startAt`; `/play` (Trials page included) shows a notice while `startAt` is later than
  `KnightsPlayer.startAtSeen`, until dismissed. A player's first look only records where they stand.
