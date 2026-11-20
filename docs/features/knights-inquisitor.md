# Knights: the in-game inquisitor queue

Moderators review settled player ratings inside the Knights game. Two moderators who give an image the same level make it a
mod-confirmed skill check ([hidden checks and smites](knights-hidden-checks-and-smites.md)), served to Acolytes and Knights.
Code: `apps/knights/src/lib/server/inquisitor/`. Tables: `KnightsInquisitorReview`, `KnightsInquisitorVote` (migration
`20271120160000_knights_inquisitor_review`, applied by hand).

## Entry

Every rating item the players settle opens one review once its level is written to the image (`markApplied`), whether it
settled by agreement or by a re-rate. A review stores the players' level (`consensusValue`). Opening it never undoes the
write-back or the payout; if it fails, the tick's sweep (`sweepMissingReviews`, `reviewsOpened` in the tick response) opens it
for items written back in the last 48 hours. Hidden checks, yes/no items and items rerouted instead of written get none.

## Two votes

A moderator is served the open reviews they have not voted on and that are not of their own image: reviews another moderator
already voted on first, then the oldest. They answer with a rating level (Blocked is not a vote; see below). The first vote
is recorded. The second closes the review:

- the same level: `confirmed`, and the image enters the skill-check pool at that level;
- another level: `split`, no check, the image keeps the players' level, both votes are kept.

A review a moderator's override already reached (the image ruled at the level the first vote named) is still served and can
still be confirmed.

When the two moderators agree on a level other than the image's, that level is written to the image as a moderator ruling
first, through the main app's moderator rating endpoint and in the name of the moderator whose vote closed the review (their
own session is used, so the main app records the ruling as theirs). Only then is the vote recorded and the review confirmed;
if the write fails, nothing is recorded and the moderator can vote again. While the write runs the review is held for that
moderator for two minutes. The image is never written while it is blocked: such a review is excluded first. The players who
settled the item keep their verdicts, XP and gold.

Moderator votes earn no XP, gold or Watch, need no player record, and never change the players' votes, verdicts, XP or gold.

## Excluded reviews

A review is closed `excluded`, with no vote recorded, when at serve or at vote a moderator has ruled on the image, it was
blocked, it moved off the players' level, or it fell under a review or hold (the skill-check pool's exclusions).

"Send to Inquisitor" is the one-moderator way to say an image should be blocked: it opens a new item at the Inquisitors
(escalation `blocked`, shown in the moderator app's Inquisitor queue) and excludes the review. The settled item and its
players' votes stay as they were.

Closes count as `knights_inquisitor_reviews_closed_total{outcome}`.

## Where moderators play it

A moderator opening `/play` gets this queue instead of the player game (`routes/play/inquisitor.server.ts`,
`InquisitorPlay.svelte`); the page needs no player record and pays nothing. Beside the image it shows the Knights' consensus
and the image's current level, how the Order voted (per answer, by the stage the votes came at), the moderator votes so far,
the prompt, and links to the image, its post and its creator on civitai.red, where tags and resources are listed. The
moderator's own stats sit on top: votes this week, reviews waiting for them, and how often they agreed with the other
moderator. Reviews are addressed by a sealed token bound to the moderator, under a key of its own, so a review token never
opens as a feed item. Both actions (`inquisitorVote`, `sendToInquisitor`) are form posts that refuse anyone but a moderator.

