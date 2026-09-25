# Crucible

Head-to-head content competitions. Creators open a crucible, entrants submit images or videos, and the community judges them two at a time. Each vote moves the entries' ELO ratings, and when the crucible ends the final ranking splits the prize pool.

Crucible is separate from the Challenges platform and its judging engine.

## Lifecycle

1. **Create.** The creator sets up the crucible and pays the setup cost. It starts right away, or at a scheduled time up to 30 days out.
2. **Enter.** While the crucible is active, entrants submit media from their library, or generate or upload it from the submit dialog. Each entry pays the entry fee.
3. **Judge.** Signed-in users are shown two entries side by side and pick one. Every vote updates both entries' ratings.
4. **Finish.** At the end time the crucible closes, final positions are fixed by rating, and prizes are paid out.

A moderator can cancel a crucible at any point. Cancelling refunds every entry fee, the setup cost and the seeded pool.

## Setup options

| Option | What it does | Cost |
|---|---|---|
| Duration | 8 hours, 24 hours, 3 days or 7 days | Free, 500, 1,000, 2,000 Buzz |
| Start date | Schedule the start instead of opening immediately | Free |
| Content type | Image or video entries | Free |
| Content rating | Which content levels entries may have | Free |
| Entry fee | Paid by each entry; feeds the prize pool | Free |
| Entry limits | Entries per user, and an optional cap on total entries | Free |
| Seeded prize pool | Buzz the creator adds to the pool up front | The seeded amount |
| Prize distribution | Custom split across positions (default 50 / 30 / 20) | 500 Buzz |
| Resource requirements | Entries must be made with one of up to 10 chosen models | 500 Buzz |
| Minimum view time *(video only)* | Judges must watch this long of both clips before voting | Free |
| Maximum clip length *(video only)* | Longer clips are refused at submission | Free |

## Prize pool

The pool is the seeded amount plus every entry fee collected. At the end it is split by the prize distribution, and ties go to the earlier entry.

## Judging

- Judges never see their own entries, and never see the same pair twice.
- Pairs favour entries with few votes, so new entries get ranked quickly.
- New entries' ratings move faster until they have enough votes.
- Judges can skip a pair.
- On video crucibles with a minimum view time, only real playback counts. Skipping ahead or pausing does not add to it. A vote on an under-watched pair is rejected, and the judge keeps that pair.

## Rankings are hidden while a crucible runs

Showing a live leaderboard would bias judges, so scores and positions stay hidden until the crucible ends. Entrants can see only their own standing. Once the crucible is completed or cancelled, the full ranking is public.

## Notifications

When a crucible ends, each entrant is told their final position and any prize, and the creator is told it has ended. Creators are also notified as entries come in.

## Availability

Crucible is behind a feature flag, currently limited to testers. Starting, closing and paying out crucibles is controlled by a separate flag, so the feature can be hidden without stranding crucibles already in progress.
