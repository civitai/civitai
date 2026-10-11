# Crucible

Head-to-head content competitions. Creators open a crucible, entrants submit images or videos, and the community judges them two at a time. Each vote moves the entries' ELO ratings, and when the crucible ends the final ranking splits the prize pool.

Crucible is separate from the Challenges platform and its judging engine.

## Lifecycle

1. **Create.** The creator sets up the crucible and pays the setup cost and any seeded pool. It starts right away, or at a scheduled time up to 30 days out. A crucible runs on the Buzz of the site it is created on (green on civitai.com, yellow on civitai.red); a green crucible is limited to PG and PG-13. On civitai.com, only crucibles limited to PG and PG-13 whose text is not mature can be entered, whichever Buzz funds them; the rest are entered on civitai.red.
2. **Review.** The name, description and cover are checked automatically before anyone else can see the crucible. Until then only its creator and moderators can open it.
3. **Enter.** While the crucible is active, entrants submit published media from their library, or generate or upload it from the submit dialog. Media added from the dialog stays an unpublished draft until it is entered, and entering schedules its post for the crucible's end; an entry that is refused, or not saved and refunded, leaves it a draft, and the dialog keeps offering it in later visits. Each entry pays the entry fee in the Buzz of the site the entrant is on, except the free entries the creator offers. The creator can't enter their own crucible.
4. **Judge.** Signed-in users with a creator score of at least 500 (and moderators) are shown two entries side by side and pick one. Every vote updates both entries' ratings.
5. **Finish.** At the end time the crucible closes, final positions are fixed by rating, and each winner is awarded a prize to claim.

### Cancelling

- The creator can cancel while the crucible is still upcoming; the setup cost and seeded pool are refunded.
- A moderator can cancel it while it runs; every entry fee, the setup cost and the seeded pool are refunded and entrants are told.
- Once it has ended with entries, it can no longer be cancelled: finalizing owns the pool from then on.
- A crucible with no entries that is past its start and has not passed review is cancelled automatically, with the setup cost and seeded pool refunded: at once if its text or cover was refused, or once review is still unfinished a day after its start or its last edit, whichever is later. The creator is told.

### Removing an entry

A moderator can remove an entry while the crucible runs. The entry fee is refunded and the entrant is told. An entrant can remove their own entry from the crucible page while it runs; there is no refund. That entry, like one whose image is deleted, can no longer be seen or place, but its fee stays in the pool. Its slot opens again under the per-user limit and the total cap, and an entry made in it pays the fee even if the gone entry was free.

## Setup options

| Option | What it does | Cost |
|---|---|---|
| Duration | 24 hours, 3 days or 7 days | Free, Free, 1,000 Buzz |
| Start date | Schedule the start instead of opening immediately | Free |
| Content type | Image or video entries | Free |
| Content rating | Which content levels entries may have | Free |
| Entry fee | Paid by each entry; feeds the prize pool | Free |
| Entry limits | Entries per user, and an optional cap on total entries | Free |
| Free entries | The first N entries per user cost nothing | Free |
| Seeded prize pool | Buzz the creator adds to the pool up front | The seeded amount |
| Prize distribution | Custom split across positions (default 50 / 30 / 20) | 500 Buzz |
| Resource requirements | Entries must be made with one of up to 10 chosen models. If a chosen model is limited to PG and PG-13, so are the crucible and every entry | 500 Buzz |
| Base models | Entries must be made with a checkpoint of one of up to 10 base models; applies on top of any resource requirement | Free |
| Minimum view time *(video only)* | Judges must watch this long of both clips before voting | Free |
| Maximum clip length *(video only)* | Longer clips are refused at submission | Free |

Settings can change only before the crucible starts; after that only the name, description and images can, until it ends.

## Prize pool

The pool is the seeded amount plus the fee of every paid entry. Free entries add nothing, so a crucible with no seed and only free entries has a pool of 0.

At the end, entries need a minimum share of votes to place; ties go to the earlier entry. Prizes follow the prize distribution, but an entrant takes at most one: their best-placed entry. Their other entries keep their positions on the leaderboard and win nothing, and the next entrant takes the next prize. When fewer entrants place than there are prizes, the unfilled shares go to the winners in proportion to their own. Entries whose media was blocked, taken down or re-rated outside the crucible's levels can't place, and their fees stay in the pool. If nobody entered, or nothing could be awarded, the seed goes back to the creator.

The discovery page's Prize Pool sort uses the same pool. Whenever upcoming crucibles are listed alongside running ones, every running crucible comes first, whatever the sort.

Prizes are plain Buzz. A winner claims theirs from the link in their results notification (or the banner on the crucible page): on civitai.com it is paid in green, and on civitai.red the winner picks green or yellow. A prize nobody claims is paid in green after 30 days. A banned winner's prize is held, neither claimable nor auto-paid, until the ban is lifted. Claiming is shared with challenge winner prizes; see `src/server/services/prize.service.ts`.

## Your crucible stats

The crucible welcome panel shows each entrant their Avg Finish and Prizes Won. Avg Finish is the mean placement percentile ("Top X%") over completed crucibles where they placed and at least 5 entrants placed, ranked by their best entry; crucibles where they did not place are left out, and it shows a dash until 3 crucibles count. Prizes Won counts only places that paid Buzz.

## Leaderboards

Three boards rank crucible activity over the last 30 days, refreshed nightly:

- **Crucible Judges:** each crucible you judge adds 10 × √(your votes in it), counting up to 50 votes per crucible, so judging many crucibles beats piling votes into one.
- **Crucible Competitors:** in each completed crucible with at least 5 placed entrants, 1 point for every entrant your best entry finished above.
- **Crucible Hosts:** each of your completed crucibles adds 10 × √(its entrants), counting entrants whose account was at least 30 days old when they entered.

## Judging

- Judges never see their own entries, and never see the same pair twice.
- Pairs favour the entries this judge has voted on least, then those with the fewest votes overall, so new entries get ranked quickly without one late entry turning up in every pair a judge sees.
- New entries' ratings move faster until they have enough votes.
- Judges can skip a pair. Skipped entries stay out for the rest of the visit (up to the last 20) and come back only once nothing else is left to judge.
- On video crucibles with a minimum view time, only real playback counts. Skipping ahead or pausing does not add to it. A vote on an under-watched pair is rejected, and the judge keeps that pair.
- Someone the creator has blocked can't see, enter or judge the crucible.

## Judging is blind while a crucible runs

On the crucible page, other people's entries show no creator and open in a media-only viewer instead of the image detail (creator, prompt, resources) until the crucible is completed or cancelled. Entrants still see their own entries in full, and moderators see everything.

Media entered from the submit dialog also stays off the entrant's profile, the public feeds and search while the crucible runs: its post is scheduled for the crucible's end, so only the entrant (under their scheduled posts) and moderators see it, and the crucible's own grid, judging and leaderboard still show the entry. It goes public at the end, or immediately when the crucible is cancelled or a moderator removes the entry. Media entered from the library was already public and stays public. While its post is hidden, the same media can't be entered into a second crucible.

## Rankings are hidden while a crucible runs

Showing a live leaderboard would bias judges, so scores and positions stay hidden until the crucible ends. Entrants can see only their own standing. Once the crucible is completed or cancelled, the full ranking is public.

## Notifications

- **Creator:** new entries, and the end (with any seed refund).
- **Entrants:** the prize they took (or their final position, without one), a cancellation and its refund, and an entry removed by a moderator.
- **Followers and entrants:** a reminder once, 8 hours before the end.
- **Followers:** the results, unless they are the creator or an entrant, who already hear about the end.

Anyone signed in can follow an upcoming or active crucible with the bell on its page. Every crucible notification except a cancellation, a moderator's removal and the notices about its review can be turned off in notification settings.

A crucible's name appears in notifications and Buzz transaction descriptions only once its text has passed review as safe for everyone; a crucible with mature text is never named there.

## Availability

Crucible is behind a feature flag, currently limited to testers. The background jobs that start, close and pay out crucibles don't check it, so hiding the feature doesn't strand crucibles already in progress.
