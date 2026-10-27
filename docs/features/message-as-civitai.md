# Message as Civitai Moderation

Moderators, and agents using a moderator's API key, can send a user a chat message from one shared
**Civitai Moderation** account instead of their own. The user sees only that account, with the staff
nameplate, and can reply in the same thread. Internally, every message records the moderator who wrote
it.

## Behaviour

- **One thread per user.** It is an ordinary 1:1 chat between the user and the shared account, so it
  shows in the user's chat list, follows normal chat retention, and the user can clear their own view.
- **Reply-only.** The shared account's DM policy is `nobody`, so users cannot start a thread with it;
  they can only answer one a moderator started. A banned user cannot post in chat at all and uses the
  appeal flow instead.
- **A tray notification** points at the thread with every message (`/?chat=<id>` opens it), because
  chat alone does not reach someone whose chat is muted or switched off.
- **Claims.** Sending claims the thread for 30 minutes and renews the claim. While another moderator
  holds an unexpired claim, sending is refused. Claims are held in `ModThreadClaim`.
- **Per-user cap.** Messages the user has not answered within the last 24 hours are capped across all
  moderators (`MESSAGE_AS_CIVITAI_DAILY_CAP`, default 5). A reply from the user resets the count.
- **Attribution.** Each message writes a `ModActivity` row (`entityType` `chatMessage`, activity
  `message-as-civitai`, the moderator as `userId`). A message sent from a report also writes a row
  linking the report. The moderator chat audit views and the moderator app's transcripts show the
  moderator next to each Civitai Moderation message.

## Where

- **Moderator app:** User Lookup → Notifications → *Message as Civitai Moderation*; the report queues'
  owner actions; and **Civitai Messages** (`/messages`), an inbox of threads awaiting a reply with a
  thread view to claim, reply and release. The sidebar badge counts threads awaiting a reply.
- **API** (`defineModeratorEndpoint`, moderator's own credentials):
  - `POST /api/mod/user/message-as-civitai`: `{ userId, message, idempotencyKey?, context?: { reportId? } }`.
    A repeated `idempotencyKey` returns the first result with `deduped: true`.
  - `GET /api/mod/messages/inbox`, `GET /api/mod/messages/thread?userId=`
  - `POST /api/mod/messages/claim`, `POST /api/mod/messages/release`: `{ userId }`
- **Skill:** `.claude/skills/mod-actions/query.mjs` `dm` (sends as Civitai Moderation; `--as-self` for
  the old behaviour), `inbox`, `thread`.

Every action needs the moderator permission `user.message.asCivitai`, granted per role on the moderator
app's `/admin`. Reaching `/messages` also needs its page grant.

## Setup

- `CIVITAI_MODERATION_USER_ID` on the main app and the moderator app: the shared account's user id. Unset
  turns the feature off.
- The shared account is a moderator account with DM policy `nobody`. It cannot sign in or act; an
  attempt is logged as an error.
- Migration `20261209000000_mod_thread_claim` (applied by hand).
