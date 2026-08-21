# Front Page Audit — coverage classification

All 16 queries bucketed per the migration skill's §2, before any code.

**What the app is.** A *proactive sweep* of the front page, not a request queue. The moderator picks one
age rating and one ordering, gets the images carrying that rating that have appeared since the last
sweep, and re-rates the ones that are wrong. A per-rating timestamp makes it resumable across sessions
and across moderators, which is the whole point: two people sweeping "X" should not re-check the same
images.

This is **not** the same tool as `/images/ratings`. That queue is reactive — images whose rating a
*user* disputed (`ImageRatingRequest`). This one is a patrol of everything newly scanned, whether or not
anyone complained. Same action, different population; both are needed.

## Classification of all 16

### port (7)

| Query | Notes |
| --- | --- |
| `ByNewestTest1236` | The live sweep: `nsfwLevel = <chosen>`, `ingestion = 'Scanned'`, `nsfwLevelLocked = false`, `createdAt > lastCheckedAt`, `ORDER BY createdAt ASC`, 200 rows. Also selects `profilePictureId` and an `ImageConnection` join → "this is someone's avatar" / "this backs a bounty". |
| `ByNewestTest1235` | The **video** variant: `type = 'video'`, 20 rows, and four extra filters — `minor = false`, `metadata->>'parentId' IS NULL`, `needsReview IS NULL`, plus `TagsOnImageDetails` instead of `TagsOnImage`. Video is slower to review, hence the smaller page. |
| `ByReactions` | The second ordering: joins `ImageRank`, `ORDER BY reactionCountWeekRank`, published posts only. "What is actually on the front page", as against "what is newest". |
| `Timestamp` | `FrontPageTimers` — `lastCheckedAt`, `username`, `buttonPressedTime` for the chosen rating. The resume point. |
| `LogTimestamp` | Writes it back (GUI-mode → `FrontPageTimers`). |
| `TagVote` | `TagsOnImageVote` upsert — the moderator agreeing/disagreeing with a moderation tag, which is how the tagger is corrected. Distinct from changing the rating. |
| `InsertRatingGame` | `research_ratings` upsert — feeds the rating-research dataset. |

### equivalent (4) — shipped, name the winner

| Query | Covered by |
| --- | --- |
| `UpdateNsfwLevel` | `updateImageNsfwLevel` (`image-nsfw-level.ts`) — same `UPDATE Image SET nsfwLevel, nsfwLevelLocked = TRUE`, and it additionally recomputes the parent model's level, busts the cache and finalises KoNO. Strictly more correct than Retool's bare UPDATE. |
| `InsertModActivity` | `recordModActivity`, called by `updateImageNsfwLevel`. Retool's literal `activity = 'setNsfwLevel'` is what that helper writes. |
| `LogNsfwLevel`, `LogNsfwLevel2` | **Not duplicates — two behaviours, two ports.** `LogNsfwLevel` fires on setting a rating; `LogNsfwLevel2` on a moderation-tag vote, additions only, taking the rating from the tag. Both are `UPDATE_OR_INSERT_BY` on `imageId`, so `RatingChanges` holds the latest change per image, not a history. Both ported 2026-08-21 — see the `RatingChanges` row in [`parity-findings.md`](parity-findings.md). |

### superseded (2)

`OLDByNewest` and `ByReactions`' filter both predicate on `i.nsfw` — the deprecated four-value enum
(`'None' | 'Soft' | 'Mature' | 'X'`) — while `ByNewestTest1235/1236` use the `nsfwLevel` bitmask.
`OLDByNewest` is superseded outright (its name says so, and `RunTheCorrectQuery` never calls it).

⚠️ **`ByReactions` is ported but its filter is not.** It still reads `i.nsfw`, so porting it verbatim
would filter the reactions view by a different, stale column than the newest view. Port the *ordering*
from `ByReactions` and the *filter* from `ByNewestTest1236`, or the two tabs disagree about what "X"
means.

### plumbing (3)

`SetSelectedFilter`, `SetSelectedAge`, `RunTheCorrectQuery`, `OpenModal` — Retool state-setters and a
dispatcher choosing between the two orderings. URL query params and a form action do all of it.

### blocked (0)

## Decisions taken without asking

**One page, two orderings and two media types — not four pages.** `RunTheCorrectQuery` switches on
`selectedFilter`; the video query is a third variant of the same sweep. Rating + ordering + media type
are URL params, so a sweep is shareable and resumable by link, per the app's URL-filtering pattern.

**Reuse `updateImageNsfwLevel` rather than re-authoring the UPDATE.** It already owns the side effects
Retool's bare UPDATE skipped. The rating write is the destructive path here and it should have exactly
one implementation.

**`RatingChanges` and `research_ratings` are separate logs and both are kept.** `RatingChanges` (363k
rows, `retool_db`) is the audit trail of corrections; `research_ratings` (main DB) is a research
dataset keyed `(userId, imageId)`. They answer different questions.

## Open — needs verification I cannot do from here

1. **The age-rating vocabulary.** The `RadioGroupWidget2` holding the rating choices is a component, and
   this export predates the option-set extractor, so its options are not captured. The SQL only shows
   the parameter (`selectedAgeRating`) compared against `nsfwLevel`. Porting against
   `@civitai/shared`'s `NsfwLevel` is the obvious reading, but **re-extract to confirm the exact set
   offered** — Retool may have limited the sweep to a subset.
2. ~~**`FrontPageTimers` and `RatingChanges` are GUI-mode writes**, so the export records the target
   table and no column list.~~ **Wrong, and it cost this item three rounds of "blocked".** GUI-mode
   queries record `actionType`, `tableName`, `filterBy` and a full `changeset` — the export carries all
   of it, inside the transit-encoded `page.data.appState` blob, which is why grepping the file found
   nothing. Read it by `JSON.parse`-ing `appState` and walking the structure, not by string-matching:
   see the corrected `RatingChanges` row in [`parity-findings.md`](parity-findings.md).
3. **`research_ratings` is not in `@civitai/db-schema/kysely`.** It exists in production (Retool writes
   it on the `Prod` resource) but is absent from the generated types, so it needs either a schema
   addition or a raw `sql` insert.
4. **The `ImageConnection` join in `ByNewestTest1236` row-multiplies** an image with several connections
   — the same defect found and fixed in Bulk Image Manager. Port it as `EXISTS`, not a join.
