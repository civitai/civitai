# Knights v2: yes/no questions

Plain yes or no questions about one image, answered by Knights and above beside the rating votes. They exist to collect human
answers for a decision model. They are first-class votes: an answer is graded against the majority exactly as a rating vote is graded
against its consensus. Nothing is written back to the image (except by the moderator tag review source below), and a yes/no answer never issues a smite (only hidden checks do).
Code is in `apps/knights/src/lib/server/yesno`; migration `20261210120000_knights_v2_tables` (applied by hand, before the app build and the import; it creates the
open-item index with the `"audience" IS NULL` predicate that exempts yes/no questions).

## Storage

A yes/no question is an ordinary `KnightsQueueItem`, so the ledger, the item row lock and the partitioned `KnightsVote` table are
shared with ratings. What marks one is `audience` (`players` or `moderators`); a rating item has it null. Extra columns on the item:

| Column                  | Holds                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `externalId`            | The producer's id for the question, unique. Imports upsert on it; labels keep it.                                                          |
| `prompt`                | The question as asked about this image.                                                                                                    |
| `audience`              | `players` (served in the feed) or `moderators` (a later moderator-app queue; never served to players).                                     |
| `yesEffect`, `noEffect` | What the producing model would rate the image for each answer. Never selected for a page.                                                  |
| `meta`                  | Provenance of the row, plus `moderation` (who changed it and why) and `rewordOf` (the producer id a reworded copy replaces). Never served. |
| `voteCount`             | Answers so far; serving finishes questions that are under way first.                                                                       |

The item's question (`questionKey`) is one `KnightsQuestion` per axis, `knights.yesno.<axis>`, kind `bool`, options yes and no.
Its `prompt` is a plain fallback question for the axis (`axisPrompt` in `keys.ts`), shown only where an item or Acolyte pair has no
question text of its own; overlapping axes share one;
`votesToResolve` (default 5) feeds the label store's rule row (`minHuman`); it and `maxVotes` no longer decide a question in the game,
which follows the rating stage rule below. The item's own `votesNeeded` is unused for yes/no.
Statuses: `Open`, `Consensus`, `Closed` (reason `no-consensus`, `unplayable`, `stale`, `retired` or `moderator-retired`). A yes/no item is never `Resolved`, so write-back and the rating
escalation and settle sweeps never touch it (it has no `expiresAt`; its own stage escalation is below). Rating `getFeed` and `castVote` exclude items with an `audience`. The partial unique index that allows one
open rating item per question and image exempts yes/no items, which share an axis and an image.

"Not sure" answers are stored in `KnightsUnsure` (migration `20271128120100_knights_unsure`, by hand, then SELECT and INSERT for
Knights' database role plus USAGE on `KnightsUnsure_id_seq`, before deploying): one row per player and question item, with the
question key and image as a snapshot and no foreign keys, so a count outlives the item. It is never a vote and nothing is paid, graded or decided from it. Count per question with
`SELECT "itemId", count(*) FROM "KnightsUnsure" GROUP BY 1`. It lives in Postgres rather than ClickHouse because the game reads it
back (a "Not sure" counts toward ending a run of questions). The `yesNoReferenceId` column is unused: Acolyte practice pairs are
graded, so they offer no "Not sure".

## Import

The CSV comes from the question producer (an offline pipeline that proposes the questions); it is not in this repository, and no real file is ever committed. Save it anywhere and pass its path. The header row names the columns; order does not matter and extra columns are ignored.

| Column                                                                              | Used as                                                                                                                                      |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `question_id`                                                                       | `externalId`, the idempotency key (max 200 chars; longer rows are rejected as `bad-id`); a repeated id in one file is skipped as `duplicate`, unless the first copy's image does not exist: then the next copy whose image exists is imported instead |
| `active_candidate`                                                                  | `true` to import; anything else retires the open item with that id                                                                           |
| `image_id`                                                                          | Positive integer id of an existing image                                                                                                     |
| `axis`                                                                              | Key matching `[a-z][a-z0-9_]{0,39}`, lower-cased before it is checked; one question per axis is created                                      |
| `kind`                                                                              | `observable` (players) or `policy_preference` (moderators)                                                                                   |
| `question`                                                                          | The prompt shown to the voter                                                                                                                |
| `yes_effect`, `no_effect`                                                           | Optional short labels for what each answer does                                                                                              |
| `case_id`, `source_purpose`, `source_batch_id`, `promotion_status`, `policy_sha256` | Optional; stored in the item's `meta`                                                                                                        |
| `reword_of`                                                                         | Optional; the producer id a cleaned-up row rewords. Stored as `meta.rewordOf`, as a moderator reword is; left out when empty                 |

A cleaned-up file replaces each reworded producer row with its `<question_id>:r1` row, and the original id must not appear in it at all. Listed as inactive, the import retires the reworded row in the same run (an open item whose `rewordOf` names a withdrawn id is closed); listed as active, both wordings are open at once. For the same reason, never import the producer's raw file after a cleaned one.

A sample, with placeholder ids (use ids of images that exist in your local database):

```csv
question_id,active_candidate,image_id,axis,kind,question,yes_effect,no_effect
sample-0001,true,1001,sample_axis,observable,Is there a person in this image?,,
sample-0002,true,1002,sample_axis,policy_preference,Should this image be restricted?,restrict,allow
sample-0003,false,1003,sample_axis,observable,Withdrawn question.,,
```

`--dry-run` parses the file and prints the counts without touching the database, so it does not check that the images exist.

`cd apps/knights && pnpm run import:yesno <file.csv> [--dry-run]` reads `DATABASE_URL` from `.env` and refuses any host other than
localhost, 127.0.0.1 or ::1 (for a dev database, forward the port first). It keeps rows marked active, maps `observable` to `players`
and `policy_preference` to `moderators`, skips a row whose image does not exist (`bad-image`) or that the public feeds would not show (`unservable-image`, the `servableImage` test), creates the axis questions once, and upserts items by `externalId` in batches. It never
rewrites an item that has answers (a changed one is reported as `refused`; the moderation record a moderator's action adds to `meta` is not a change), and closes an open item the file marks inactive
(`retired`, no outcome), along with any open reworded copies of it; a question it withdrew earlier and lists again, with no
answers, is reopened. It skips an unanswered item a moderator changed (counted as `moderated`), except that a moderated item the file
withdrew and relists is reopened and rewritten. It never reopens one closed as `moderator-retired`; relisting it brings back its latest
reworded copy instead, if the import had closed that copy. It prints counts only. Data files are never committed.

**Temporary launch page.** The script cannot reach production, so `/admin/yesno-import` in the Knights app runs the same import once at launch.
It is moderator-only (an explicit `isModerator` check on the page load and on its POST; others get 403), is not linked from any navigation,
and is to be removed after the Knights v2 launch import. The browser splits the cleaned file into chunks of at most 400 rows (and 256 KB, to stay under the
node adapter's request body limit), repeats the header in each, and posts them one after another; each chunk runs `toYesNoRows`, drops rows whose image does not exist (`bad-image`) or cannot be served (`unservable-image`) and runs `importYesNo`,
and the page sums the counts, showing `moderated` and each skip reason on their own. It is dry-run by default (parse, check the images exist and can be served, and count; no writes). Each real chunk is logged to Axiom with the moderator id and counts.
Upload only the cleaned file: a withdrawn id is retired only within its own chunk's run, which is why the file must hold no inactive rows.

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

- Questions come in bursts (`cadence.ts`, `BURSTS`): a gap of 15, 18 or 20 ratings, then a burst of 5 to 10 questions, each length
  rolled anew per player. `burstDue` reads the player's last 21 votes and "Not sure" answers (`KnightsUnsure`, a question
  served, so a run ends at its length whatever the answer) plus the items already handed out ahead (`servedHistory`; a
  hidden check counts as a rating), and rolls each length from the item that ended the run before it, so a reload or the look-ahead
  never re-rolls. A due burst comes before the hidden-check roll; a hidden check rides only on a rating slot. When no question is
  left, the slot is a rating; with no rating to show, a question is shown whenever there is one. A share of 0 switches questions
  off; any other value leaves the cadence as it is. The share comes from `yesNoShare` on `system:knights-v2-sources`, set by the
  "Yes/no questions" switch on the moderator app's Knights of New Order Config page (On stores 1, Off 0, Default clears it; read by
  Knights at most every 30 s), else from `KNIGHTS_YESNO_SHARE`.
  The stretch and the max age below work the same way ([game settings](knights-sources.md#game-settings)).
- Players can turn questions off on `/settings` ("Yes/no questions", labelled beta; `KnightsPlayer.yesNoQuestions`, migration
  `20271128120000_knights_player_question_settings`, by hand). The switch is read in `pickItem` (`playerPrefs`, on every pick, no
  cache), the one place a queue yes/no becomes due, so it covers the generated questions, the Paladin tag review source and
  `GET /play/next` alike. A player who never touched it follows `yesNoPlayerDefault` on the Config page (off unless set), and a
  failed read serves no question. Items handed out before a change can still be answered. Acolytes get no switch: their practice
  pairs (`KnightsYesNoReference`) are part of the apprenticeship. While the Config page serves no questions at all (share 0 and tag
  review off), the Questions section is hidden; the stored choice is kept for when they come back.
- From Knight up, `/settings` also has "Hide content": one switch per preset tag group (`KNIGHTS_TAG_GROUPS` in
  `apps/knights/src/lib/server/knights-tag-groups.ts`: furry, male focus, feet, bondage, futanari, gore, picked from the open
  queue's tags and agreed with Moderation; separate from the main site's browsing categories; stored as keys in
  `KnightsPlayer.hiddenTagGroups`, where a key no longer in the list hides nothing). The queue reserves nothing per player, so a
  hidden image stays open for every other player. An image with an enabled tag of a hidden group (`TagsOnImageDetails`) is not served to that
  player anywhere: rating feed, rating vote, late Watch credit, yes/no pick and vote, hidden checks. `servedTo` in
  `queue/vote-record.ts` is that one check, next to the hidden-creator one, and reads the groups inside the query, so it cannot fail
  open. No group is a browsing level, a whole kind of sexual content or an orientation tag alone (unit tests pin it): Knights is where mature content gets rated. A
  player's own hidden tags on the site never apply, and Acolyte practice is not filtered.
- A stretch is `KNIGHTS_YESNO_STRETCH` questions of one axis in a row (default 8); the next axis starts with a banner. The player's
  latest yes/no answers in the ledger say where they are in a stretch, so no state is kept. `GET /play/next` hands out up to 10 items at once, so each pick also counts the yes/no questions already handed out ahead of it and not yet on the ledger (`ahead` in `pickYesNo`): the stretch cap and the new-category banner hold across the buffer, and the banner is on the first question of a stretch only.
- A question is offered only to a rank that may judge Knight items, on an image `servableImage` accepts, if it is `Open`, if the
  player has not answered it, and if they have not answered the same words about the same image under another id. Questions under
  way come first, so they reach their consensus.
- The page gets the words, a sealed token (`feed-token.ts`), the image and a banner heading. It never gets the producer's id, the
  effects, the axis, the model's prediction or the image's rating.
- Y and N answer on the page.

## Answering (`vote.ts`)

`castYesNoVote` is the rating vote's path with a different decision: the same pacing gate (and, ahead of it in the `/play` action, the same Redis vote limits), join gate, `reset-pending` and `no-weight`
refusals, and `insertVote` / `creditVote`. The ledger row is under the item's own id, with `answer` `yes` or `no`, the vote XP at once
and gold held as pending. The item row lock serialises its votes.

A stage decides a question by the rating stage rule (`STAGE_RULES` in `queue/stage-rules.ts`, applied by `decideChoice`): unanimous at
the answers the stage needs, then one answer holding 75% up to the stage's cap. One vote per player, as the label store counts; only the
current stage's (`minRank`) answers count, and earlier stages' answers stay pending and are graded by the final outcome.

| Stage | Settles at | Then (yes-no) | Cap |
|---|---|---|---|
| Knight | 4-0 | 4-1, 5-1, 6-1, 6-2, 7-2, 8-2 | 10 |
| Templar | 3-0 | 3-1, 4-1, 5-1 | 6 |
| Paladin | 2-0 | 3-0, 3-1 | 4 |

A stage that reaches its cap without that agreement (a plain majority such as 7-3 included) does not close the question while a higher rank is staffed: it moves to the next
staffed rank (`nextStaffedRank` over `staffedRanks`, as a rating item escalates: Knight, then Templar, then Paladin), with
`escalatedAt` set and no deadline. Players below that rank are no longer served it or allowed to answer (`stagesWorkedBy` in the feed,
`canVote` in `insertVote`). At the last staffed stage it closes as `no-consensus`; a yes/no question never goes to the Inquisitors.

At the close, in the same transaction:

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

## Moderator tag review source (`tag-review.ts`, `tag-writeback.ts`)

Paladins also answer the moderator app's image tag review queue (`/images/tags`) as yes/no questions: "Should this image have
the tag <name>?", yes keeps the tag, no removes it. The queue itself does not change: moderators keep seeing every flagged tag,
and whichever side rules first takes it out of the other's queue. Off unless the moderator Config page switches it on
(`modTagReview` in `system:knights-v2-sources`, absent is off); switching on is in [Knights queue sources](knights-sources.md#paladin-tag-review).

- **Items.** Source `mod-tag-review`, axis `tag_review` (heading "Tag review"), audience `players`, created at the Paladin stage
  with no deadline (`expiresAt` null, so `escalateExpired` never moves or expires them), `externalId`
  `mod-tag:<imageId>:<tagId>:<episode>`, `meta { tagId, episode }`. Created through `importYesNo`, like the CSV import.
- **Create (tick).** With the switch on and an active Paladin, the tick walks the flagged tag rows a page at a time within a time
  budget, resuming where the last run stopped (process memory; a restart starts over, and the upsert makes reruns idempotent).
  A row gets an item when its tag is a Moderation tag below Blocked and its image passes `modReviewEligibleImage`
  (`@civitai/db/knights`) on a published post.
- **Eligibility.** One predicate, `modReviewEligibleImage`, keeps staff-only images away from players: it includes every image a
  moderator without the CSAM grant may not see (`moderatorWithheldSql`), read by Knights through the gate view's `modReviewContent`
  column. It runs where an item is
  created, served, voted on and swept, and in the moderator app's write-back guard; an item whose image stops passing it is no
  longer served, its vote is refused and an answered one is swept `unplayable`.
- **Episodes.** Each time a tag is flagged after a ruling it gets a fresh item (`episode` + 1); while the latest item is open, awaiting
  write-back, or closed without the flag ever clearing, nothing new is created. When a tag stops being flagged (a moderator ruled, or
  it was disabled or removed), the tick closes its open item `moderator-ruled` (votes inconclusive) or stamps a finished one
  `episodeEnded`, for items of the last 30 days. This runs with the switch off too.
- **Deciding.** The Paladin stage rule applies, never the Inquisitors: four answers without agreement close `no-consensus` and the tag
  stays with moderators. A "no" that would lower the image's rating (`removalLowersLevel`, read under the item lock at vote time) does
  not settle on the 2-0 minimum and follows the 75% rule instead; keeps and level-neutral removals settle 2-0. The players'
  answers go to the label store like any yes/no answer.
- **Write-back (tick).** A settled item is written back through the moderator app's `image-tag-moderate` action
  (`@civitai/moderation`), which runs the queue's own `moderateImageTags` in a guarded mode and records `moderateTagKono` for the
  player who closed the consensus: that activity in image lookup is the history of player rulings. Outcomes `applied` and
  `already-ruled` end the episode; `ineligible` and `missing` are final and leave the tag with moderators. A moderator app that is
  not ready (not deployed, not configured, credential not accepted) is retried without spending attempts; other failures back off
  and stop at the attempt cap as `attempts-exhausted` (paid, not applied). Config: `MODERATOR_APP_INTERNAL_URL` (else
  `MODERATOR_APP_URL`) and `KNIGHTS_TAG_REVIEW_TOKEN`.
- The moderator Questions tab leaves these items out: a reworded copy would ask something other than the tag it writes back.

## Players see

`/judgments` shows the question's words and the answer; it is pending until the question closes, then right, wrong or set aside like
any rating. The Codex has a short paragraph that says only that an answer is graded against the Order's final answer. Hotkeys, banner and the status line are in `/play`. On a question, Skip is a "Not sure" answer pill (Space, the same `?/skip`
action: no pay, no smite, plus a `KnightsUnsure` row, best effort); ratings keep Skip. An Acolyte's practice pair has no "Not sure": every
pair is graded, and abstaining would keep a wrong answer out of the promotion window (`?/apprentice` refuses `unsure` as an answer
not on offer). A run of questions opens with "Question time" and ends with a "Questions done"
banner ([motion](knights-motion-and-sound.md)). A hidden check is rolled only on a rating slot, at its own rate
(`KNIGHTS_HIDDEN_CHECK_RATE`).

The rules the questions test are shown as "Question rules" below the rating levels, in the Codex rating guide and in the guide
window on `/play` (`apps/knights/src/lib/question-rules.ts`; change the text there). A yes/no question shows the guide button,
which opens the guide at the rules.
