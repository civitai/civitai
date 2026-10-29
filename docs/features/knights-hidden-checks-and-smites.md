# Knights v2: hidden checks and smites

Both live in the Knights app (`apps/knights`). Smites use the main app's `NewOrderSmite` table and `resetPlayer`, so the original
game and the new one agree. Values are in `src/lib/server/hidden/config.ts` and `src/lib/server/smites/config.ts`. Migration
`20261219120000_knights_v2_smites` (applied by hand).

## Hidden checks (`src/lib/server/hidden`)

Known-answer images (`KnightsReferenceImage`, pool `hiddenCheck`) served in a Knight's feed beside queue items.

- `/play` asks `pickHiddenCheck` before the queue.
- Every feed item, check or queue item, is addressed by a sealed token (`feed-token.ts`, key `FEED_TOKEN_SECRET`), so the page cannot
  tell them apart. The vote action opens the token and routes to `castVote` or `answerHiddenCheck`.
- `answerHiddenCheck` grades against the known answer at once and shows the verdict. It writes no `KnightsVote`, queue item,
  write-back, XP or gold. Answers are kept in `KnightsHiddenCheckAnswer` and count in the accuracy ledger (`ledgerOf`).
- A wrong answer can have a smite as a consequence.

## Smites (`src/lib/server/smites`)

- Smites live in the shared `NewOrderSmite` table; `voteWeight` already reads them.
- Cleansing: correct votes settled in `settleItemVotes` work smites off, and the tick lapses old ones (`expireSmites`).
- The status bar shows the hearts left.
- Reset: the Knights app calls the main app's `POST /api/mod/knights/reset-player` (`x-webhook-token`), which reuses the single
  `resetPlayer` and is safe to repeat. If the call fails the active smites are the pending record: `castVote` refuses
  (`reset-pending`) and the tick retries (`resetPendingPlayers`).
- Notice: after a reset `/play` shows a notice until dismissed (`KnightsPlayer.resetNoticeSeenAt`).
