# Knights v2: queue escalation

An open queue item waits at one stage (Knight, Templar or Paladin) for `KNIGHTS_STAGE_TTL_HOURS` (72 h). It leaves the stage when its votes settle, when its votes split to the stage maximum, or when the window lapses. `POST /api/jobs/tick` handles the lapse (`escalateExpired`); a split is handled in `castVote`. Both hand an item up through the same function (`escalate` in `queue.service.ts`).

## Rule 1: stages nobody can serve are skipped

An item is never handed to a stage nobody can serve. On every escalation, whatever the reason, the item goes to the next stage after its own that has an eligible player at that rank or higher (`nextStaffedRank`), or to the Inquisitors when none does. A higher rank can judge a lower stage (`canVote`), so with only Paladins an item leaving the Knight stage goes to the Templar stage, where Paladins serve it; with no Templars and no Paladins it goes straight to the Inquisitors.

Eligible means a `NewOrderPlayer` who voted within the last 14 days (`ACTIVE_PLAYER_DAYS`) and is not waiting on a career reset (`SMITES.max` active smites, the same bar `insertVote` refuses at). Idle accounts do not make a rank count. `staffedRanks` reads this once per tick (at most one query per rank, top down), and once per split vote.

## Rule 2: an item nobody voted on is extended, within a bound, not escalated

When the window lapses and the item has no vote at its current stage, it stays at that stage for another window, as long as someone can serve that stage (rule 1). It is not stamped as escalated (`escalatedAt`, `escalationReason` are untouched), keeps its priority, and stays in the feed. Votes cast at earlier stages do not count; only votes at the current stage do.

Extension lasts until two stage windows after the item entered the stage (`escalatedAt`, else `createdAt`). With the default first window that is one extension; an item enqueued with a shorter custom `expiresAt` can be extended twice within the bound. This bounds the case where the only eligible players have already judged the image, so no one can answer it. An item with at least one vote at the stage goes on to rule 1.

## Rule 3: an item still unvoted after its extension expires

An item that still has no counted vote at its current stage once its extension is used up closes instead of moving on: status `Closed`, `reason = 'expired'`, at any stage. Unvoted overflow never becomes moderator work. Nothing is decided: no label, no write-back, and the image keeps its level. Any vote left on it (a held player's at weight 0, or one from an earlier stage) becomes `inconclusive`; the tick's settle step (`settleFinalItems`, which runs next) then settles it unpaid, one item at a time, so one failed settlement cannot hold up the expiry batch.

An item at a stage nobody can serve is not extended. It is handed up as rule 1 says when a later stage is served, and expires when that hand-up would reach the Inquisitors with no counted vote at its stage.

The tick response carries `escalated`, `toInquisitor`, `extended` and `expired`; each expiry also counts as `knights_escalations_total{reason="expired"}`.

## Items Knights can never serve

The tick closes open rating items (not hidden checks, not yes/no items) that no player could ever be served before they expire (`closeUnservableItems`, before `settleFinalItems`, at most 200 per tick, rows another transaction holds are skipped). Each closes like `expired`: status `Closed`, no label, no write-back, the image keeps its level, and any leftover vote becomes `inconclusive` and settles unpaid. The feed serves only `servableImage`, so these items can no longer be served. An image or post can be deleted after players have already voted on its item, though, and those votes end inconclusive and unpaid, the same outcome `expired` would give them.

- `reason = 'unservable'`: the image row is gone, or the image's post is (`Image.post` is `onDelete: SetNull`). At any stage.
- `reason = 'publishes-after-expiry'`: the post is scheduled to publish after the latest moment the item could still be open (`knightsLatestStageEnd` in `@civitai/shared/new-order`, the same rule in SQL: the current window's end once it reaches two stage windows after queueing, else one more window after it). Only for an item still at the stage it was queued at (Knight, never escalated) with no counted vote there, and one that expires. Drafts are left alone.

The main app refuses to queue the second kind in the first place (`publishes-after-expiry`, see [Knights queue sources](knights-sources.md)). The tick response carries `unservable` and `publishesAfterExpiry`; each close also counts as `knights_escalations_total{reason}` with its reason.

## An open item a moderator has since ruled on

When a moderator locks an image's level after its item was queued, the tick closes the open item instead of letting players keep judging it (`closeModeratorRuledItems`, before `settleFinalItems`). The rule is the one the write-back applies to a settled item (`moderatorRuling` in `resolution.ts`): a lock other than Knights' own (`KNIGHTS_VOTE_NSFW_LEVEL_REASON`) at a level. The item becomes `Closed`, `reason = 'moderator-ruled'`, `resolvedValue` = the moderator's level, and its votes are graded and paid against that level through the write-back's own path (`reroute`). It acts only on an item still `Open` under its row lock, so an item a vote, the escalation or the Inquisitors moved first is left alone; `Resolved`, `Closed` and `Inquisitor` items are never regraded. A blocked image, or a lock without a level, is left to the other paths. The tick response carries `moderatorRuled` (items closed); an item that fails is retried next tick and counted as `knights_tick_item_failures_total{step="moderator_ruled"}`.

## Rating write-back to the main app

A settled rating is written by `main-app.ts` via the main app's `/api/mod/image/kono-set-nsfw-level` (activity
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
- An `Open` item whose image a moderator locks at a level before it settles is closed the same way by the tick
  (`closeModeratorRuledItems`, `moderatorRuled` in the tick response), only while the item is still `Open` under its row lock.
- Once a vote commits, a failure settling it is logged and the player still gets the accepted answer; the item stays
  `Resolved` and the job retries it.

## Sources

Scan sampling and owner ratings feed the queue only while `system:knights-v2-sources` (`{enabled, sfwRate, nsfwRate, maxOpen?, yesNoShare?, game?}`) is on. Scan sampling also pauses while more than `maxOpen` Knight-stage items are open (see [Knights queue sources](knights-sources.md)). Moderators switch the sources and set both rates from the moderator app's Knights of New Order Config page; each save is recorded in `ModActivity` with the value before and after. The main app reads the key with a 30 s cache.
