# Knights v2: queue escalation

An open queue item waits at one stage (Knight, Templar or Paladin) for `KNIGHTS_STAGE_TTL_HOURS` (72 h). It leaves the stage when its votes settle, when its votes split to the stage maximum, or when the window lapses. `POST /api/jobs/tick` handles the lapse (`escalateExpired`); a split is handled in `castVote`. Both hand an item up through the same function (`escalate` in `queue.service.ts`).

## Rule 1: stages nobody can serve are skipped

An item is never handed to a stage nobody can serve. On every escalation, whatever the reason, the item goes to the next stage after its own that has an eligible player at that rank or higher (`nextStaffedRank`), or to the Inquisitors when none does. A higher rank can judge a lower stage (`canVote`), so with only Paladins an item leaving the Knight stage goes to the Templar stage, where Paladins serve it; with no Templars and no Paladins it goes straight to the Inquisitors.

Eligible means a `NewOrderPlayer` who voted within the last 14 days (`ACTIVE_PLAYER_DAYS`) and is not waiting on a career reset (three active smites, the same bar `insertVote` refuses at). Idle accounts do not make a rank count. `staffedRanks` reads this once per tick (one query), and once per split vote.

## Rule 2: an item nobody voted on is extended, within a bound, not escalated

When the window lapses and the item has no vote at its current stage, it stays at that stage for another window, as long as someone can serve that stage (rule 1). It is not stamped as escalated (`escalatedAt`, `escalationReason` are untouched), keeps its priority, and stays in the feed. Votes cast at earlier stages do not count; only votes at the current stage do.

Extension lasts until two stage windows after the item entered the stage: an item whose stage entry (`escalatedAt`, else `createdAt`) is more than two windows old is handed up instead. With the default first window that is one extension; an item enqueued with a shorter custom `expiresAt` can be extended twice within the bound. This bounds the case where the only eligible players have already judged the image, so no one can answer it. An item at a stage nobody can serve is handed up at once, and an item with at least one vote at the stage goes on to rule 1 as well.

The tick response carries `escalated`, `toInquisitor` and `extended`.
