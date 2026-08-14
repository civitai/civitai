# Chat / DM redesign — implementation plan

Working plan for ClickUp `868kguhpy`, built against Ellie's mockup (*Civitai Chat — Redesign
Mockup*, 2026-08-01) and the 2026-08-12 product call. Companion to
[chat-system.md](chat-system.md), which describes the system as it exists today.

Not everything in the mockup is in this plan. Emoji, stickers, reactions and chat themes depend
on the cosmetics work in `868kk3t0t` (Entity Reactions V2, `CosmeticType.Sticker`,
`CosmeticType.ChatTheme`) and are tracked there. This plan covers the four slices that are
buildable against the chat system as it stands:

| Phase | Slice | Migration? | Status |
|-------|-------|-----------|--------|
| 1 | Privacy & abuse — graded DM policy, Requests, new-account hold | yes | built |
| 2 | Conversation management — settings, pin, notification levels, delete | yes | next |
| 3 | Surface redesign — grouped rows, reply quotes, composer, virtualized list | no | |
| 4 | Moderation audit — edit/clear events, edit length cap, per-message delete | yes | |

## Corrections to the source card

Two things in `868kguhpy` were already stale when it was written, and one decision in the mockup
was superseded by the product call. Recorded here so they don't get re-litigated.

1. **"No real opt-out" was already fixed.** The card's number-one finding — that the chat control
   only hides chats and does not stop delivery — stopped being true on 2026-06-04 in
   `9283937de2`. `upsertChat` drops recipients whose `features.chat === false` and returns
   *"This user is not accepting chat requests."* The card was compiled 2026-07-27 from a 180-day
   Discord window that was still surfacing pre-fix complaints. The real gap is narrower: the
   control is **binary**. That is what Phase 1 fixes.
2. **No image or GIF support.** Ellie ruled out user-supplied images, GIFs and external image
   embeds to keep the surface moderatable. `ChatMessageType.Image` is reserved for stickers only;
   no upload path is being added.
3. **The moderation audit trail goes to ClickHouse, not Postgres.** The mockup specs an
   append-only `ChatMessageRevision` table. On the call the decision was ClickHouse, following
   the `entityChangeEvents` precedent. See Phase 4.

## Phase 1 — Privacy & abuse

The binary on/off becomes a graded policy, and messages that fail it land in a **Requests**
bucket instead of being refused. Ticket #66756 is the shape: a user who turned chat off and
still wanted a way back in for people they know.

### Settings

`userSettingsChat` (stored on `User.settings.chat`) gains:

```ts
dmPolicy: 'everyone' | 'following' | 'mutuals' | 'nobody'   // default 'everyone'
holdNewAccounts: boolean                                    // default true
```

`holdNewAccounts` defaults **on**, which changes behaviour for every existing user: a sender
whose account is under 7 days old lands in Requests rather than the inbox. That is the mockup's
default state and the only part of Phase 1 that attacks the 7,566 reports/30d without the
recipient opting in, but it is a product default worth a second look before release — flipping
it to off costs one line in `DEFAULT_CHAT_SETTINGS`.

`features.chat` stays the master switch for the chat UI as a whole — it hides your own chat
button, which is more than "who can DM me". `dmPolicy: 'nobody'` and `features.chat === false`
express the same intent from the recipient's side, so they resolve through one helper rather
than being read independently:

```ts
resolveDmPolicy(settings, features) // features.chat === false ⇒ 'nobody'
```

### Enforcement

In `upsertChat`, the current per-recipient `features.chat === false` drop is replaced by a
policy evaluation per recipient:

| Policy | Sender passes | Sender fails |
|--------|---------------|--------------|
| `everyone` | inbox | — |
| `following` | recipient follows sender → inbox | Requests |
| `mutuals` | both follow → inbox | Requests |
| `nobody` | — | dropped; existing error preserved |

`holdNewAccounts` is evaluated on top: a sender whose account is under 7 days old lands in
Requests regardless of policy. Moderators bypass everything, as they do today.

Only `nobody` refuses. Everything else creates the chat and marks the recipient's membership.

### Data

```prisma
model ChatMember {
  // ...
  filteredAt DateTime?   // set when this chat reached the member via Requests
}
```

`filteredAt` rather than a boolean so the mod log can order events without a second column.

### Requests bucket

The rail's segmented control becomes **Inbox / Requests / Archived**, replacing
Active / Pending / Archived:

- **Inbox** — `Joined`, plus `Invited` where `filteredAt IS NULL`
- **Requests** — `Invited` where `filteredAt IS NOT NULL`
- **Archived** — `Ignored`, `Left`, `Kicked` (unchanged)

`getUnreadMessagesForUserHandler` must exclude members with `filteredAt` set, or a filtered
request still rings the header badge and the filtering achieves nothing.

Accepting a request needs no extra handling: the existing invite accept/reject moves the member
to `Joined`, and the bucket rule only consults `filteredAt` for `Invited` members, so the thread
moves to the inbox on its own.

The global settings live on their own screen inside the chat window, opened by the ⚙ in the rail
header — the same place the mockup puts it. *Message sounds* and *hide offensive words* moved
there out of the thread-list tool menu, and **Mark all read** became a button in the rail header
rather than a menu item, per the mockup's one-home-per-action rule.

### Retroactivity

**Policy changes are not retroactive.** Existing threads stay in the inbox; the policy gates
chats created after the change. Sweeping existing conversations into Requests reproduces the
"my messages disappeared" complaint shape that generated 11 tickets in a day on 2026-06-04.

## Phase 2 — Conversation management

### Data

```prisma
enum ChatNotifyLevel { All, Mentions, None }

model ChatMember {
  // ...
  notifyLevel ChatNotifyLevel @default(All)
  pinnedAt    DateTime?
  clearedAt   DateTime?
}
```

`isMuted` already exists and today means "notifications off for this conversation" (it is
unrelated to `ctx.user.muted`, which is the site-wide moderation mute that gates posting).
`isMuted = true` backfills to `notifyLevel = None`; the column stays but stops being read for
notification decisions.

### Delete conversation

Tickets #70178 and #65185. A delete stamps `clearedAt` on the requester's own `ChatMember` row
and clears the thread from their account. Rows are retained, so a `ChatReport` filed against
the thread still resolves to its evidence — a report must not be detachable by either
participant. Because `Chat.hash` dedupes on participants, the next conversation with that person
resolves to the same `Chat` row and reads as empty behind the watermark, which is the "clean
slate" behaviour asked for.

Read paths that must respect the watermark: `getInfiniteMessages` (filter
`createdAt > clearedAt`), the `getAllByUser` preview, and unread counts.

### Settings surface

One modal, two scopes, matching the mockup: a **Global** tab and a **this conversation** tab.

- **Global** — who can message me (Phase 1), filtering toggles, notification defaults. Message
  sounds and *hide offensive words* ship today but are buried in a thread-list menu; they move
  here.
- **Per-conversation** — notification level (Everything / Only when mentioned / Nothing) and
  pin. Preferences only.

Actions live in the conversation's `⋯` menu and nowhere else — Report, Archive, Delete for 1:1;
Add people, Leave for groups. One home per action; no duplicate controls in settings.

`markAllAsRead` already exists server-side and is currently reachable only from a menu. It
becomes the **Mark all read** button in the rail header.

## Phase 3 — Surface redesign

A Discord × Telegram cross. From Discord: flat grouped message rows, hover action bar,
sender-coloured usernames. From Telegram: centered date chips, reply quotes, the rounded
composer with in-field send. Deliberately dropped from both: nested threads, voice, presence
complexity, server structure.

- **Grouped rows** — consecutive messages from one sender collapse under a single header.
- **Reply quotes** — `createMessageInput.referenceMessageId` already exists and the UI has a
  read path, but it resolves each quote through a separate `getMessageById` query
  (`ExistingChat.tsx` carries a TODO acknowledging this). The reference is joined into
  `getInfiniteMessages` instead.
- **Composer** — live character counter, amber at 1,800, red past 2,000. Today the cap surfaces
  as an error after you have written the message.
- **Virtualized message list** — `getInfiniteMessagesInput.limit` defaults to **1,000**, with
  the comment *"this is high for now because of issues with scrolling"*. Fix the scrolling, then
  drop the page size. This is a prerequisite for group chat, which multiplies volume onto the
  same read path.

## Phase 4 — Moderation audit

### Edit path

`updateMessage` exists as a handler but is **unrouted**, and `updateMessageInput` has **no max
length** — where `createMessageInput` caps content at 2,000. Routing it as-is would open an
uncapped write path. Before it is routed it needs the cap and the guards `createMessage` applies
to new content: blocklist/profanity scanning and sticker ownership resolution.

### Per-message delete

Ellie's ask on the call, and it sits next to reply in the hover bar. Deleting your own message
sets `ChatMessage.deletedAt` (the schema already carries the TODO): it disappears for both
sides, the row is retained.

### Event log

Edits, conversation clears and per-message deletes emit rows to a ClickHouse table via a
`Tracker` method, following the `entityChangeEvents` pattern in
`src/server/clickhouse/tracker.ts` — flag-gated so the app can deploy before the table exists.
Retaining the record is what keeps a `ChatReport` reviewable after a participant clears their
side of the thread; without it, a report filed today can be rendered unreviewable tomorrow.

## Open

- **Sticker asset spec** — emoji are fixed at 128×128 (D6). Stickers render far larger and need
  their own numbers before any creator uploads one. Belongs in `cosmeticImageRequirements`.
  Tracked in `868kk3t0t`.
- **Chat themes at lapsed membership** — Civitai cosmetics persist once granted; Discord revokes
  Nitro themes on lapse. Product call, plus the tier map. Tracked in `868kk3t0t`.
- **Status banner** — the 2026-06-04 outage generated 11 tickets in a day and was never
  acknowledged in-product. Surfacing the existing incident feed inside the chat panel is on the
  card but not scheduled here.
