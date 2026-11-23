# Knights: the in-game inquisitor queue

Moderators review settled player ratings inside the Knights game. Two moderators who give an image the same level make it a
mod-confirmed skill check ([hidden checks and smites](knights-hidden-checks-and-smites.md)), served to Acolytes and Knights.
Code: `apps/knights/src/lib/server/inquisitor/`. Tables: `KnightsInquisitorReview`, `KnightsInquisitorVote` (migration
`20271120160000_knights_inquisitor_review`, applied by hand).

## The switch

The whole feature sits behind the `inquisitorQueue` game setting (Config page "In-game inquisitor queue", else
`KNIGHTS_INQUISITOR_QUEUE`), off by default. Off, no review opens (neither on write-back nor in the tick's sweep), moderators
get the player game on `/play`, the review actions answer 404, and the mod-confirmed pool is served to nobody.

## Entry

Every rating item the players settle opens one review once its level is written to the image (`markApplied`), whether it
settled by agreement or by a re-rate. A review stores the players' level (`consensusValue`). Opening it never undoes the
write-back or the payout; if it fails, the tick's sweep (`sweepMissingReviews`, `reviewsOpened` in the tick response) opens it
for items written back in the last two hours, a bounded number per run. The open backlog is capped (`inquisitorMaxOpen`,
Config page, default 5,000): each tick expires the oldest open reviews no moderator has voted on beyond it (status
`expired`, `reviewsExpired`); a review with a vote is never expired. The queue is played a little each week and is not a
backlog to clear.

## Two votes

A moderator is served the open reviews they have not voted on and that are not of their own image and not held by another
moderator mid-override: reviews another moderator already voted on first (oldest first), then the newest unvoted ones, each
read as one bounded batch. They answer with a rating level (Blocked is not a vote; see below). The first vote
is recorded. The second closes the review:

- the same level: `confirmed`, and the image enters the skill-check pool at that level;
- another level: `split`, no check, the image keeps the players' level, both votes are kept.

When the two moderators agree on a level other than the image's, that level is written to the image as a moderator ruling
first, through the main app's moderator rating endpoint and in the name of the moderator whose vote closed the review (their
own session is used, so the main app records the ruling as theirs). Only then is the vote recorded and the review confirmed;
if the write fails, nothing is recorded and the moderator can vote again. Before the write the image is judged at its
current level; a predicate that depends on the level only decides whether the image becomes a check. When the agreed level
keeps it out of the pool, the level is still written and the review confirmed, with no check, and the moderator is told the
image won't be used as a skill check. If the level lands but the review cannot close, the moderator's vote is still
recorded. While the write runs the review is held for that
moderator for two minutes. The image is never written while it is blocked: such a review is excluded first. The players who
settled the item keep their verdicts, XP and gold.

Moderator votes earn no XP, gold or Watch, need no player record, and never change the players' votes, verdicts, XP or gold.

## Excluded and held reviews

A review is closed `excluded`, with no vote recorded, when the image is gone, was blocked, moved off the players' level, was
ruled on by a moderator, or fails one of the skill-check pool's safety predicates that do not lift on their own. The tick
checks a small batch of open reviews per run, least recently checked first (`checkedAt`), in a short transaction that skips
reviews a moderator holds, closes the ones that fail and stamps the rest (`reviewsClosed` in its response). A review whose image fails one that lifts in time (an open report or appeal, a scan hold, a
scan still running, an Inquisitor ruling under way) stays open: it is not served, and a vote on it is refused, until that
clears. Serving reads only reviews whose image passes the predicates now, so held reviews never crowd out servable ones, and
the waiting count counts only those. If the predicates cannot be read, the page says the queue cannot load and nothing is
served or recorded (`knights_skill_check_reads_unreadable_total`).

Only the closing moderator's own override counts as theirs: the image ruled at the agreed level in the same request, or,
on a retry under their own claim, a ruling the main app recorded as theirs after the claim. A ruling by anyone else, at any
level, closes the review. The image is checked once more right before the write. If the main app does not answer, the
image is read again: ruled at the agreed level, the review closes; otherwise the moderator is told the level may have been
taken and to check the image before voting again. If the level was written but the review then cannot close, the moderator
is told so and it is counted (`knights_inquisitor_overrides_unclosed_total`). Only the moderator's session cookie is
forwarded, never following a redirect, and only to an https main app (or a local one). A confirmation the pool cannot take
(the image held, or its checks unreadable) rolls back and can be retried; a core trial image, or a check already graded at
another level, keeps its row and the review still confirms.

"Send to Inquisitor" is the one-moderator way to say an image should be blocked (refused while another moderator holds the review): it opens a new item at the Inquisitors
(escalation `blocked`, shown in the moderator app's Inquisitor queue) and excludes the review. The settled item and its
players' votes stay as they were.

Closes count as `knights_inquisitor_reviews_closed_total{outcome}`.

## Where moderators play it

A moderator opening `/play` gets this queue instead of the player game (`routes/play/inquisitor.server.ts`,
`InquisitorPlay.svelte`); the page needs no player record and pays nothing. Beside the image it shows the Knights' consensus
and the image's current level, how the Order voted (per answer, by the stage the votes came at), the moderator votes so far,
the prompt (clamped, with "Show full prompt"), the image's tags, and links to the image, its post and its creator on
civitai.red, where resources are listed. The image and its answer row always fit the screen (the sidebar scrolls on its
own); the levels are the player game's answer pills (`$lib/AnswerPill.svelte`), and the number keys vote them in order.
"Should be Blocked" sits last in the sidebar and asks to confirm before it sends the image to the Inquisitors. The
moderator's own stats sit on top: votes this week, reviews waiting for them (counted up to 1,000), and how often they agreed with the other
moderator. Reviews are addressed by a sealed token bound to the moderator, under a key of its own, so a review token never
opens as a feed item. Both actions (`inquisitorVote`, `sendToInquisitor`) are form posts that refuse anyone but a moderator.

