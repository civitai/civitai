# Knights "What's new"

How the Knights app tells players about the game: a one-time welcome after the v2 launch, then an entry for each change
players will notice.

## The launch dialog

`$lib/WhatsNewDialog.svelte`, with its copy and `ANNOUNCEMENT_URL` in `$lib/whats-new.ts`: a one-time dialog for members,
shown on whichever of `/home` or `/play` they open first. Both loads read `whatsNew` from `readNotices`, both answer
`?/dismissWhatsNew`, and the root layout renders it.

- A player with v1 progress (`isReturningPlayer`: any XP or a rank above Acolyte) gets the "what changed" copy; a newcomer
  gets a welcome that explains how the Order works (`whatsNewCopy`).
- It comes before the rating guide: while it is unseen, `readNotices` holds back the guide and progress notices.
- Got it, Escape and the backdrop close it at once and write a per-user browser marker (`knights:whats-new-seen:<userId>`
  in localStorage). The layout posts the dismiss in the background and re-reads the page once it is stored, so the guide
  follows. While the server still sends the copy to a browser whose marker says seen, it is re-sent instead of shown
  (`whats-new-dismiss.ts`).
- The marker is read only after hydration, so the dialog is never server-rendered and a no-JS client does not get it.
- Seen state on the server is the `whatsNew` flag in `knights:seen:<userId>` (`lib/server/seen.ts`; a record without it
  reads as unseen). Delete that key and the browser marker to see it again locally; this also shows the guide again.

## Entries

Each change players will notice gets a file under `apps/knights/whats-new/` (format in that folder's README).
`lib/server/whats-new/entries.ts` parses them at build time and throws on a bad file; `whats-new.test.ts` reads every real
one.

- **Seen:** the same seen record holds `updatesSeen`, the newest entry the player saw. A first look and closing the launch
  dialog set it to the newest entry; a record from before entries existed reads as none seen, so its player gets every
  entry.
- **Layout data:** the root layout load sends `updates`: the entries for the player's rank, newest first, at most 6, and
  how many are newer than `updatesSeen`. Nothing counts as unseen while the launch dialog is unseen.
- **Header:** the scroll button (`$lib/WhatsNewButton.svelte`) opens the entries dialog (`updatesCopy`, in the same
  `WhatsNewDialog`) and wears a dot while any are unseen.
- **Opening by itself:** unseen entries open the dialog once on `/home` and `/play`, never over another dialog (the launch
  dialog, the content warning, `/play`'s rating guide or a rank-up); they wait for the next load (`$lib/updates.ts`,
  `updates.svelte.ts`).
- **Closing** clears the dot at once, writes `knights:whats-new-entry:<userId>` in localStorage and posts
  `POST /whats-new`, which records the newest entry as seen. A browser that closed it but whose post failed sends it again
  once per load.
- **Known limit:** an entry with a `minRank` is not marked new for a player who reaches that rank later (the marker is one
  newest id), though it is in their list from then on.

The yes/no Question time card also carries a permanent line pointing at Settings, where Knights can turn questions off.
