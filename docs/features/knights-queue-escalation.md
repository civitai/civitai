# Knights v2: queue escalation

An open queue item waits at one stage (Knight, Templar or Paladin) for `KNIGHTS_STAGE_TTL_HOURS` (72 h). It leaves the stage when its votes settle, when its votes split to the stage maximum, or when the window lapses. `POST /api/jobs/tick` handles the lapse (`escalateExpired`); a split is handled in `castVote`. Both hand an item up through the same function (`escalate` in `queue.service.ts`).

## Rule 1: stages nobody can serve are skipped

An item is never handed to a stage nobody can serve. On every escalation, whatever the reason, the item goes to the next stage after its own that has an eligible player at that rank or higher (`nextStaffedRank`), or to the Inquisitors when none does. A higher rank can judge a lower stage (`canVote`), so with only Paladins an item leaving the Knight stage goes to the Templar stage, where Paladins serve it; with no Templars and no Paladins it goes straight to the Inquisitors.

Eligible means a `NewOrderPlayer` who voted within the last 14 days (`ACTIVE_PLAYER_DAYS`) and is not waiting on a career reset (`SMITES.max` active smites, the same bar `insertVote` refuses at). Idle accounts do not make a rank count. `staffedRanks` reads this once per tick (at most one query per rank, top down), and once per split vote.

## Rule 2: an item nobody voted on is extended, within a bound, not escalated

When the window lapses and the item has no vote at its current stage, it stays at that stage for another window, as long as someone can serve that stage (rule 1). It is not stamped as escalated (`escalatedAt`, `escalationReason` are untouched), keeps its priority, and stays in the feed. Votes cast at earlier stages do not count; only votes at the current stage do.

Extension lasts until two stage windows after the item entered the stage (`escalatedAt`, else `createdAt`). With the default first window that is one extension; an item enqueued with a shorter custom `expiresAt` can be extended twice within the bound. This bounds the case where the only eligible players have already judged the image, so no one can answer it. An item with at least one vote at the stage goes on to rule 1.

## Rule 3: an item still unvoted after its extension expires

An item that still has no counted vote at its current stage once its extension is used up closes instead of moving on: status `Closed`, `reason = 'expired'`, at any stage. Unvoted overflow never becomes moderator work. Nothing is decided: no label, no write-back, and the image keeps its level. Any vote left on it (a held player's at weight 0, or one from an earlier stage) becomes `inconclusive` and settles unpaid, as `closeWithoutOutcome` does.

An item at a stage nobody can serve is not extended. It is handed up as rule 1 says when a later stage is served, and expires when that hand-up would reach the Inquisitors with no counted vote at its stage.

The tick response carries `escalated`, `toInquisitor`, `extended` and `expired`; each expiry also counts as `knights_escalations_total{reason="expired"}`.

## Sources

Scan sampling and owner ratings feed the queue only while `system:knights-v2-sources` (`{enabled, sfwRate, nsfwRate, maxOpen?}`) is on. Scan sampling also pauses while more than `maxOpen` Knight-stage items are open (see [Knights queue sources](knights-sources.md)). Moderators switch the sources and set both rates from the moderator app's Knights of New Order Config page; each save is recorded in `ModActivity` with the value before and after. The main app reads the key with a 30 s cache.
