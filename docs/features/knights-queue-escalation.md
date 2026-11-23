# Knights v2: queue escalation

An open queue item waits at one stage (Knight, Templar or Paladin) for `KNIGHTS_STAGE_TTL_HOURS` (72 h). It leaves the stage when its votes settle, when its votes split to the stage maximum, or when the window lapses. `POST /api/jobs/tick` handles the lapse (`escalateExpired`); a split is handled in `castVote`. Both hand an item up through the same function (`escalate` in `queue.service.ts`).

## Rule 1: stages nobody can serve are skipped

An item is never handed to a stage nobody can serve. On every escalation, whatever the reason, the item goes to the next stage after its own that has an eligible player at that rank or higher (`nextStaffedRank`), or, when none does, it has reached the end of the path (rule 4). A higher rank can judge a lower stage (`canVote`), so with only Paladins an item leaving the Knight stage goes to the Templar stage, where Paladins serve it; with no Templars and no Paladins the Knight stage is the end of the path.

Eligible means a `NewOrderPlayer` who voted within the last 14 days (`ACTIVE_PLAYER_DAYS`) and is not waiting on a career reset (`SMITES.max` active smites, the same bar `insertVote` refuses at). Idle accounts do not make a rank count. `staffedRanks` reads this once per tick (at most one query per rank, top down), and once per split vote.

## Rule 2: an item nobody voted on is extended, within a bound, not escalated

When the window lapses and the item has no vote at its current stage, it stays at that stage for another window, as long as someone can serve that stage (rule 1). It is not stamped as escalated (`escalatedAt`, `escalationReason` are untouched), keeps its priority, and stays in the feed. Votes cast at earlier stages do not count; only votes at the current stage do.

Extension lasts until two stage windows after the item entered the stage (`escalatedAt`, else `createdAt`). With the default first window that is one extension; an item enqueued with a shorter custom `expiresAt` can be extended twice within the bound. This bounds the case where the only eligible players have already judged the image, so no one can answer it. An item with at least one vote at the stage goes on to rule 1.

## Rule 3: an item still unvoted after its extension expires

An item that still has no counted vote at its current stage once its extension is used up closes instead of moving on: status `Closed`, `reason = 'expired'`, at any stage. Unvoted overflow never becomes moderator work. Nothing is decided: no label, no write-back, and the image keeps its level. Any vote left on it (a held player's at weight 0, or one from an earlier stage) becomes `inconclusive`; the tick's settle step (`settleFinalItems`, which runs next) then settles it unpaid, one item at a time, so one failed settlement cannot hold up the expiry batch.

An item at a stage nobody can serve is not extended. It is handed up as rule 1 says when a later stage is served, and expires when that hand-up would reach the Inquisitors with no counted vote at its stage.

An expired item whose image's post is Private goes to the Inquisitors as `blocked` when the counted votes of the latest stage that has any (its current stage first) pick Blocked (ties go high), at any stage and vote count; every other item follows the rules above.

The tick response carries `escalated`, `toInquisitor`, `extended`, `expired` and `rerated`; each expiry also counts as `knights_escalations_total{reason="expired"}`. It also reports `reviewsOpened` and `reviewsClosed`, the [inquisitor reviews](knights-inquisitor.md) its sweeps opened and closed. A moderator's "Send to Inquisitor" from a review opens a new `blocked` item here, source `inquisitor-review`.

## Rule 4: a split at the end of the path is re-rated

A rating item that leaves its stage without agreement (a split at the stage maximum, or a lapsed window with votes) and has no staffed stage after it does not go to the Inquisitors. It resolves on its own (`rerate` in `queue.service.ts`):

- The level is the answer with the most counted votes (weight > 0) at the item's current stage, counted, not weighted; a tie goes to the highest level (`mostVotedLevel` in `resolution.ts`). One PG-13, four R and four X give X; mostly PG-13 with one XXX gives PG-13. The stage consensus itself keeps its weighted rule (`decideChoice`).
- Rating down is allowed: the pushed-down check guards a consensus, not a re-rate. A Blocked pick goes to the Inquisitors as `escalationReason = 'blocked'`, as a Blocked consensus does.
- A lapsed window re-rates only when the stage has at least its quorum of counted votes (`votesNeededAt`: Knight 4, Templar 3, Paladin 2); with fewer it closes as `expired` (rule 3's close), unless those votes pick Blocked: that goes to the Inquisitors as `blocked` at any count.
- The item becomes `Resolved` with `reason = 'no-consensus-rerate'`, `resolvedFromLevel` the image's level, and the latest counted voter who gave the level as the write-back's actor. Every vote on it, at any stage, becomes `inconclusive`: no gold and no correct-answer XP, only the XP each vote earned when cast. Judgment history shows the player's own answer and no resolved level.
- It is written back like any settled rating (below), so a moderator lock, a block or a moved level reroutes it the same way: a moderator's level grades the votes against it, a block or a moved level sends it to the Inquisitors with its votes pending again.

A rating item never reaches the Inquisitors as `no-consensus` any more; another choice question still does. Each re-rate counts as `knights_escalations_total{reason="no-consensus-rerate"}`.

## Items Knights can never serve

The tick closes open rating items (not hidden checks, not yes/no items) that no player could ever be served before they expire, or, for a scan sample, whose post is still a draft a day after queueing, and Inquisitor items whose image is gone (`closeUnservableItems`, after `closeModeratorRuledItems` and before `settleFinalItems`, at most 200 per tick shared by every reason below, oldest item first, rows another transaction holds are skipped). Each closes like `expired`: status `Closed`, no label, no write-back, the image keeps its level, and any leftover vote becomes `inconclusive` and settles unpaid. The feed serves only `servableImage`, so these items can no longer be served, except an `unpublished-draft` item whose post publishes later: its close is final all the same, and nothing re-queues it. An image or post can be deleted after players have already voted on its item, though, and those votes end inconclusive and unpaid, the same outcome `expired` would give them.

- `reason = 'unservable'`: the image row is gone, or the image's post is (`Image.post` is `onDelete: SetNull`). At any stage. An item waiting on the Inquisitors (`Inquisitor`, or `Ruling` once the moderator's claim lease has lapsed) closes this way only when the image row itself is gone, which no moderator could rule on: an image an evidence hold kept after its post was deleted still can be. A ruling in progress (`Ruling` within its lease) is left alone, and an Inquisitor item whose image still exists is never closed here, blocked or not: Blocked escalations wait for a moderator by design.
- `reason = 'image-unservable'`: the post is live (published, not later than the tick) but the image no longer passes `servableImageContent` (`@civitai/db/knights`, the image half of `servableImage`): Blocked level, ingestion Blocked or a `blockedFor` marker, held for review (`needsReview`), flagged poi, minor or acceptable minor, or unrated (level 0), once the image is scanned (ingestion `Scanned` or `Blocked`): an image still waiting on its scan, such as one an owner rated before the scan landed, stays open and becomes servable when the scan lands. The feed skips such an item, so it would only wait out its windows. Open items only, at any stage. An image whose level a moderator locked is left to `closeModeratorRuledItems`, which runs first and pays the votes against that level. A draft or scheduled post is left to the two reasons below, whatever the image.
- `reason = 'publishes-after-expiry'`: the post is scheduled to publish after the latest moment the item could still be open (`knightsLatestStageEnd` in `@civitai/shared/new-order`, the same rule in SQL: the current window's end once it reaches two stage windows after queueing, else one more window after it). Only for an item still at the stage it was queued at (Knight, never escalated) with no counted vote there, and one that expires. Drafts are left to the next reason.
- `reason = 'unpublished-draft'`: a scan sample (`source = 'scan-sample'`) whose post is still a draft (`publishedAt` null) more than 24 hours after the item was queued (`UNPUBLISHED_DRAFT_HOURS`, measured from the item's `createdAt`). Many drafts never publish, and until then the item only fills the queue. At any stage, whether or not it expires; a vote left over from before the post went back to a draft settles unpaid like the others. An owner's rating (`owner-rating`) on a draft is left open.

The main app refuses to queue an owner rating of the `publishes-after-expiry` kind in the first place, and samples an image only once its post is live (see [Knights queue sources](knights-sources.md)), so `unpublished-draft` now catches a post taken back to a draft after sampling, and items queued before that change. The tick response carries `unservable`, `publishesAfterExpiry`, `unpublishedDrafts` and `imageUnservable`; each close also counts as `knights_escalations_total{reason}` with its reason. The open items it closes join the tick's live-update moves, so players holding one in their buffer drop it.

## An open item a moderator has since ruled on

When a moderator locks an image's level after its item was queued, the tick closes the open item instead of letting players keep judging it (`closeModeratorRuledItems`, before `settleFinalItems`). The rule is the one the write-back applies to a settled item (`moderatorRuling` in `resolution.ts`): a lock other than Knights' own (`KNIGHTS_VOTE_NSFW_LEVEL_REASON`) at a level. The item becomes `Closed`, `reason = 'moderator-ruled'`, `resolvedValue` = the moderator's level, and its votes are graded and paid against that level through the write-back's own path (`reroute`). It acts on an item that is still `Open` or waiting on the Inquisitors (`Inquisitor`) under its row lock, so a moderator's ruling in another queue or tool also clears the Inquisitor queue, except a Blocked consensus, which always waits for a moderator; an item a vote moved to `Resolved`, one already `Closed`, and one a moderator has claimed on the Inquisitor page (`Ruling`) are left alone. When an item goes to the Inquisitors, `meta.escalatedFromLevel` records the image's level at that moment (what a pushed-down consensus was measured from), and the Inquisitor card shows it when the level has since moved. A blocked image, or a lock without a level, is left to the other paths. The tick response carries `moderatorRuled` (items closed); an item that fails is retried next tick and counted as `knights_tick_item_failures_total{step="moderator_ruled"}`.

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
- An `Open` or `Inquisitor` item whose image a moderator locks at a level before it settles is closed the same way by the
  tick (`closeModeratorRuledItems`, `moderatorRuled` in the tick response), only while it is still in one of those statuses under its row lock.
- Once a vote commits, a failure settling it is logged and the player still gets the accepted answer; the item stays
  `Resolved` and the job retries it.

## Sources

Scan sampling and owner ratings feed the queue only while `system:knights-v2-sources` (`{enabled, sfwRate, nsfwRate, maxOpen?, yesNoShare?, game?}`) is on. Scan sampling also pauses while more than `maxOpen` Knight-stage items are open (see [Knights queue sources](knights-sources.md)). Moderators switch the sources and set both rates from the moderator app's Knights of New Order Config page; each save is recorded in `ModActivity` with the value before and after. The main app reads the key with a 30 s cache.
