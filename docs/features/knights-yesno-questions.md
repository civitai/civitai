# Knights v2: yes/no questions

Plain yes or no questions about one image, answered by Knights and above beside the rating votes. They exist to collect human
answers for a decision model. They are first-class votes: an answer is graded against the majority exactly as a rating vote is graded
against its consensus. Nothing is written back to the image, and a yes/no answer never issues a smite (only hidden checks do).
Code is in `apps/knights/src/lib/server/yesno`; migration `20261210120000_knights_v2_tables` (applied by hand, before the app build and the import; it creates the
open-item index with the `"audience" IS NULL` predicate that exempts yes/no questions).

## Storage

A yes/no question is an ordinary `KnightsQueueItem`, so the ledger, the item row lock and the partitioned `KnightsVote` table are
shared with ratings. What marks one is `audience` (`players` or `moderators`); a rating item has it null. Extra columns on the item:

| Column | Holds |
|---|---|
| `externalId` | The producer's id for the question, unique. Imports upsert on it; labels keep it. |
| `prompt` | The question as asked about this image. |
| `audience` | `players` (served in the feed) or `moderators` (a later moderator-app queue; never served to players). |
| `yesEffect`, `noEffect` | What the producing model would rate the image for each answer. Never selected for a page. |
| `meta` | Provenance of the row, plus `moderation` (who changed it and why) and `rewordOf` (the producer id a reworded copy replaces). Never served. |
| `voteCount` | Answers so far; serving finishes questions that are under way first. |

The item's question (`questionKey`) is one `KnightsQuestion` per axis, `knights.yesno.<axis>`, kind `bool`, options yes and no.
Its `prompt` is a plain fallback question for the axis (`axisPrompt` in `keys.ts`), shown only where an item or Acolyte pair has no
question text of its own; overlapping axes share one;
`votesToResolve` is the number of answers a consensus needs (default 5) and `maxVotes` the most it is ever asked (default 10); both are
read from the row on every answer, so tuning it takes effect at once (`/codex` quotes the fewest across axes). A `maxVotes` below
`votesToResolve` is treated as `votesToResolve`. The item's own `votesNeeded` is unused for yes/no.
Statuses: `Open`, `Consensus`, `Closed` (reason `no-consensus`, `unplayable`, `stale`, `retired` or `moderator-retired`). A yes/no item is never `Resolved`, so write-back, escalation and the
settle sweeps never touch it. Rating `getFeed` and `castVote` exclude items with an `audience`. The partial unique index that allows one
open rating item per question and image exempts yes/no items, which share an axis and an image.

## Import

`cd apps/knights && pnpm run import:yesno <file.csv> [--dry-run]` reads `DATABASE_URL` from `.env` and refuses any host other than
localhost, 127.0.0.1 or ::1 (for a dev database, forward the port first). It keeps rows marked active, maps `observable` to `players`
and `policy_preference` to `moderators`, creates the axis questions once, and upserts items by `externalId` in batches. It never
rewrites an item that has answers (a changed one is reported as `refused`), and closes an open item the file marks inactive
(`retired`, no outcome), along with any open reworded copies of it; a question it withdrew earlier and lists again, with no
answers, is reopened. It skips an unanswered item a moderator changed (counted as `moderated`), except that a moderated item the file
withdrew and relists is reopened and rewritten. It never reopens one closed as `moderator-retired`; relisting it brings back its latest
reworded copy instead, if the import had closed that copy. It prints counts only. Data files are never committed.

## Moderator cleanup

The moderator app's Trials page has a Questions tab (same grant) listing player questions, filterable by axis and status and searchable
by text or image. A moderator can:

- **Retire** an open question for its image, with a required note. It closes as `moderator-retired` and its pending answers become
  `inconclusive`; the Knights tick (`settleFinalItems`) settles them later, dropping their pending gold. Answers already recorded stay in
  the label store.
- **Restore** a `moderator-retired` question that has no answers. Restore is refused while a reworded copy of it is open (retire the copy first), so a question never has two live versions.
- **Reword** a question. This always retires it and opens a new item `<producer id>:rN` with `meta.rewordOf`, so answers under a producer
  id are always answers to the producer's wording.

Closing a row is shared with Knights (`closeYesNoItemRow` in `@civitai/db/knights`). The moderator locks only the item row and its
votes, never player rows.

## Serving (`feed.ts`)

- Each feed slot rolls once, per player, against `KNIGHTS_YESNO_SHARE` (default above one half; 0 switches questions off). The roll is
  fixed until the player answers, so a reload does not change it. With no rating to show, a question is shown whenever there is one.
- A stretch is `KNIGHTS_YESNO_STRETCH` questions of one axis in a row (default 8); the next axis starts with a banner. The player's
  latest yes/no answers in the ledger say where they are in a stretch, so no state is kept.
- A question is offered only to a rank that may judge Knight items, on an image `servableImage` accepts, if it is `Open`, if the
  player has not answered it, and if they have not answered the same words about the same image under another id. Questions under
  way come first, so they reach their consensus.
- The page gets the words, a sealed token (`feed-token.ts`), the image and a banner heading. It never gets the producer's id, the
  effects, the axis, the model's prediction or the image's rating.
- Y and N answer on the page.

## Answering (`vote.ts`)

`castYesNoVote` is the rating vote's path with a different decision: the same pacing gate, join gate, `reset-pending` and `no-weight`
refusals, and `insertVote` / `creditVote`. The ledger row is under the item's own id, with `answer` `yes` or `no`, the vote XP at once
and gold held as pending. The item row lock serialises its votes.

A question has a consensus when `votesToResolve` players have answered and one answer has a strict majority (one vote per player, as the
label store counts). A tie keeps it open until `maxVotes`, when it is closed with no outcome. At the close, in the same transaction:

- The majority answer is graded `correct` and the others `failed`; a close with no outcome leaves every vote `inconclusive`, as for a
  rating item. The item becomes `Consensus`, which counts as final, and the votes are paid by `settleItemVotes`, the rating path.
- So a right answer earns the bulk XP and moves its gold from pending to earned, counts in accuracy, fervor and the rank bars, can
  promote, and works an active smite off; a wrong one drops its gold. An answer given before a career reset pays nothing into the new
  career. A vote settles once (`settledAt`), and the tick's settle sweep covers a close that crashed after committing.

## Closing without an answer

The tick (`sweep.ts`) closes, with no outcome, answered players' questions that cannot finish on their own: their image is no longer
shown or their axis is switched off (`unplayable`), or nobody has answered for `KNIGHTS_YESNO_MAX_AGE_DAYS` (default 14, `stale`).
Votes become `inconclusive`, their gold is dropped, the vote XP stays, labels already written stay. The sweep walks every answered
question in id order a page at a time within a time budget and steps over one it cannot close, so a few cannot hold back the rest. Questions with no answers hold nothing
and are left open. Moderators' questions are not swept. A vote locks its own player row first, then the item row; a close, whether in a vote or in the sweep, locks the item row, then the voters' player rows in id order.

## Labels

Each answer becomes a `knight` label in the label store, written by the tick as given (not when graded), never for a
held player: question `knights.yesno.<externalId>`, value `yes` or `no`, one label per answer, unique source ref. Each answered
question gets its own `rule` row, so the store computes the majority per question. Details: `docs/features/label-store.md`.

## Players see

`/judgments` shows the question's words and the answer; it is pending until the question closes, then right, wrong or set aside like
any rating. The Codex has a short paragraph. Hotkeys, banner and the status line are in `/play`. A hidden check is offered before a question is rolled for, so its rate does
not depend on the yes/no share.
