# Crucible

Head-to-head content competitions. Creators open a crucible, entrants submit images or videos, and the community judges them two at a time. Each vote moves the entries' ELO ratings, and when the crucible ends the final ranking splits the prize pool.

Crucible is separate from the Challenges platform and its judging engine.

## Lifecycle

1. **Create.** The creator sets up the crucible and pays the setup cost and any seeded pool. It starts right away, or at a scheduled time up to 30 days out. A crucible runs on one Buzz type (yellow or green) and lives only on that currency's site; a green crucible is limited to PG and PG-13.
2. **Review.** The name, description and cover are checked automatically before anyone else can see the crucible. Until then only its creator and moderators can open it.
3. **Enter.** While the crucible is active, entrants submit published media from their library, or generate or upload it from the submit dialog. Media added from the dialog stays an unpublished draft until it is entered, and entering publishes it; a refused or refunded entry leaves it a draft. Each entry pays the entry fee in the Buzz of the site the entrant is on, except the free entries the creator offers.
4. **Judge.** Signed-in users are shown two entries side by side and pick one. Every vote updates both entries' ratings.
5. **Finish.** At the end time the crucible closes, final positions are fixed by rating, and prizes are paid out.

### Cancelling

- The creator can cancel while the crucible is still upcoming; the setup cost and seeded pool are refunded.
- A moderator can cancel it while it runs; every entry fee, the setup cost and the seeded pool are refunded and entrants are told.
- Once it has ended with entries, it can no longer be cancelled: finalizing owns the pool from then on.

### Removing an entry

A moderator can remove an entry while the crucible runs. The entry fee is refunded and the entrant is told. An entry whose image is deleted is not removed: it can no longer be seen or place, but its fee stays in the pool.

## Setup options

| Option | What it does | Cost |
|---|---|---|
| Duration | 8 hours, 24 hours, 3 days or 7 days | Free, 500, 1,000, 2,000 Buzz |
| Start date | Schedule the start instead of opening immediately | Free |
| Buzz type | Yellow or green | Free |
| Content type | Image or video entries | Free |
| Content rating | Which content levels entries may have | Free |
| Entry fee | Paid by each entry; feeds the prize pool | Free |
| Entry limits | Entries per user, and an optional cap on total entries | Free |
| Free entries | The first N entries per user cost nothing | Free |
| Seeded prize pool | Buzz the creator adds to the pool up front | The seeded amount |
| Prize distribution | Custom split across positions (default 50 / 30 / 20) | 500 Buzz |
| Resource requirements | Entries must be made with one of up to 10 chosen models. If a chosen model is limited to PG and PG-13, so are the crucible and every entry | 500 Buzz |
| Minimum view time *(video only)* | Judges must watch this long of both clips before voting | Free |
| Maximum clip length *(video only)* | Longer clips are refused at submission | Free |

Settings can change only before the crucible starts; after that only the name, description and images can.

## Prize pool

The pool is the seeded amount plus the fee of every paid entry. Free entries add nothing, so a crucible with no seed and only free entries has a pool of 0.

At the end, entries need a minimum share of votes to place. Those that place split the pool by the prize distribution; ties go to the earlier entry. Entries whose media was blocked, taken down or re-rated outside the crucible's levels can't place, and their fees stay in the pool. If nobody entered, or nothing could be awarded, the seed goes back to the creator.

The discovery page's Prize Pool sort uses the same pool.

## Judging

- Judges never see their own entries, and never see the same pair twice.
- Pairs favour the entries this judge has voted on least, then those with the fewest votes overall, so new entries get ranked quickly without one late entry turning up in every pair a judge sees.
- New entries' ratings move faster until they have enough votes.
- Judges can skip a pair.
- On video crucibles with a minimum view time, only real playback counts. Skipping ahead or pausing does not add to it. A vote on an under-watched pair is rejected, and the judge keeps that pair.
- Someone the creator has blocked can't see, enter or judge the crucible.

## Judging is blind while a crucible runs

On the crucible page, other people's entries show no creator and open in a media-only viewer instead of the image detail (creator, prompt, resources) until the crucible is completed or cancelled. Entrants still see their own entries in full, and moderators see everything.

## Rankings are hidden while a crucible runs

Showing a live leaderboard would bias judges, so scores and positions stay hidden until the crucible ends. Entrants can see only their own standing. Once the crucible is completed or cancelled, the full ranking is public.

## Notifications

- **Creator:** new entries, and the end (with any seed refund).
- **Entrants:** their final position and any prize, a cancellation and its refund, and an entry removed by a moderator.
- **Followers and entrants:** a reminder once, 8 hours before the end. A crucible that runs 8 hours or less gets none.
- **Followers:** the results, unless they are the creator or an entrant, who already hear about the end.

Anyone signed in can follow an upcoming or active crucible with the bell on its page. The reminder and the results can each be turned off in notification settings.

A crucible's name appears in notifications and Buzz transaction descriptions only once its text has passed review.

## Availability

Crucible is behind a feature flag, currently limited to testers. The background jobs that start, close and pay out crucibles don't check it, so hiding the feature doesn't strand crucibles already in progress.
