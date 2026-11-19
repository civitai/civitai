# Knights live updates

/play in Knights of New Order listens on Civitai's signal service (SignalR) so that an item settled by other players leaves
everyone's queue at once, and the player's stats (gold, XP, hearts, Watch) move without a page read. Without the service the
page works exactly as before: a vote on a settled item is refused (and counted toward the Watch when it settled moments ago),
and the page reads its data again after each vote.

## Switching it on and off

- `SIGNALS_ENDPOINT` (server: sends signals, mints access tokens) and `PUBLIC_SIGNALS_ENDPOINT` (browser: the hub) must both be
  set.
- The `signalsDisabled` kill switch on the moderator app's Config page (else `KNIGHTS_SIGNALS_DISABLED`) turns it off within
  30 seconds without a deploy: `/api/signals-token` then answers null, so pages stop connecting, and nothing is sent.

## Queue drops

- Each item /play serves carries `item.live`, an opaque key (`liveKey`, an HMAC of the item id with the feed secret). Topic
  payloads reach anyone who subscribes, so a signal never names an item or image id. A skill check gets a key that is never
  announced, so it looks like any other item.
- When an item leaves the stage it was open at (resolved, closed, sent to the Inquisitors, or escalated), `announceMoves`
  sends `knights-queue-drop` on `knights-queue:<that stage>` with `{ drops: [{ k, to }] }`, where `to` is the stage it is
  open at now, or null.
- The vote action reads the item's stage before the vote and announces after it. The tick announces items that lapsed
  (`escalateExpired`) or that a moderator ruled (`closeModeratorRuledItems`).
- /play joins the topic of every stage the player judges. A drop removes the item from the buffer, unless it moved to a stage
  the player also judges. The item on screen is swapped for the next ready one, with a short notice.

## Stats

- The voters of an item that became final (up to 25) get a private `knights-player` signal: `{ at, status, daily }`, the same
  shape /play's load returns.
- /play takes it only when no vote is in flight, it is newer than the page's data and the last signal taken, and it counts at
  least as many votes today as the page shows (`acceptsStats`). The header reads the same status.
- Items settled by the tick (write-back retries, the moderator app's rulings) send no stats; they show on the next page read.

## Failure

Every send is best effort with a 3-second timeout and is logged, never thrown into a vote or the tick. A missed drop means the
vote is refused as before; a missed stats signal means the stats move on the next page read.
