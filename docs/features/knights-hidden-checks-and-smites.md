# Knights v2: hidden checks and smites

Both live in the Knights app (`apps/knights`). Smites use the main app's `NewOrderSmite` table and `resetPlayer`, so the original
game and the new one agree. Values are in `src/lib/server/hidden/config.ts` (set from the environment, see `.env.example`) and
`src/lib/server/smites/config.ts`. Migration `20261219120000_knights_v2_smites` (applied by hand).

## Hidden checks (`src/lib/server/hidden`)

Known-answer images (`KnightsReferenceImage`, pool `hiddenCheck`) served in a Knight's feed beside queue items.

- `/play` asks `pickHiddenCheck` once the queue has produced its item for the page.
- Every feed item, check or queue item, is addressed by a sealed token (`feed-token.ts`, key `FEED_TOKEN_SECRET`). The vote action
  opens the token and routes to `castVote` or `answerHiddenCheck`, which answer the same way, so nothing tells a check apart.
- `answerHiddenCheck` writes no `KnightsVote`, queue item, write-back, XP or gold. Answers are kept in `KnightsHiddenCheckAnswer`
  and count in the accuracy ledger (`ledgerOf`).
- A wrong answer can cost the player a warning or a smite. It is stored on the answer and shown once on a later page
  (`takeHiddenNotices`), in the original game's wording; the hearts in the status bar show the smites.

## Smites (`src/lib/server/smites`)

- Smites live in the shared `NewOrderSmite` table; `voteWeight` already reads them.
- Cleansing: correct votes settled in `settleItemVotes` work smites off, and the tick lapses old ones (`expireSmites`).
- Reset: the Knights app calls the main app's `POST /api/mod/knights/reset-player` (`x-webhook-token`), which reuses the single
  `resetPlayer` under a per-player lock and is safe to repeat. If the call fails the active smites are the pending record:
  `castVote` and `answerHiddenCheck` refuse (`reset-pending`) and the tick retries (`resetPendingPlayers`) before it expires smites.
- Notice: a reset moves `NewOrderPlayer.startAt`; `/play` (Trials page included) shows a notice while `startAt` is later than
  `KnightsPlayer.startAtSeen`, until dismissed. A player's first look only records where they stand.
