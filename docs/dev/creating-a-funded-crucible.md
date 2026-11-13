# Creating a funded Crucible

How staff set up a Crucible with a seeded prize pool, for example for an event. The feature itself is described in [`docs/features/crucible.md`](../features/crucible.md).

## Who pays

No separate funding step exists. `crucible.create` charges the setup cost and the seeded pool to the creating account's own Buzz balance, in one call (`createCrucible` in `src/server/services/crucible.service.ts`). The account must already hold that much Buzz.

The Buzz colour follows the domain the call goes to: `civitai.com` charges green, `civitai.red` charges yellow. Before creating, check the creator's balance in the colour you need. A green Crucible is limited to PG and PG-13, and only PG and PG-13 Crucibles can be entered on `civitai.com`.

Cost is the seed plus setup. A 24-hour or 3-day run is free, a 7-day run costs 1,000. A custom prize split costs 500; the default 50/30/20 split is free. A resource requirement costs 500.

The creator can't enter their own Crucible, so any house entries need a different account.

## Steps

1. Get the name, description, cover, settings and Buzz colour approved.
2. Upload the cover and keep its `url`, `width` and `height`.
3. Call `crucible.create` as the funding account, on the domain whose Buzz pays. Store the returned id before doing anything else, so a retry can't create a second Crucible.
4. For an event, have a moderator set the Crucible's event tags.
5. Read the Crucible back as a non-moderator account on the same domain. Signed-out tRPC reads are refused. Check status, seeded pool, end time, that the scan finished (`ingestion` is `Scanned`), and the settings as sent. Then open the page signed out on both domains.

## Traps

- The description is capped at 500 characters. Fit the text to that before it is approved.
- Minimum view time and maximum clip length apply to video Crucibles only; leave them unset on an image Crucible.
- Editing the text sends the Crucible back through the text scan, which hides it from everyone else for about a minute.
- A Crucible that is past its start and still hasn't passed review a day later (at once if its text is refused) is cancelled and refunded automatically. Create a scheduled Crucible early enough to see its scan pass before it starts.
- The start can be scheduled up to 30 days ahead; leave it unset to start immediately. Settings lock at the start. After that only the name, description and images can change.
