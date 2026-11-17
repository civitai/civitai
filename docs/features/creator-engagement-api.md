# Creator engagement API

`GET /api/v1/creator/engagement` returns per-item engagement counts for the **caller's own** images,
videos and models. It exists so a creator (or a tool holding the creator's API key) can pick their
best-performing work, for example for a showcase.

Code: `src/pages/api/v1/creator/engagement.ts` (route) and
`src/server/services/creator-engagement.service.ts` (queries). Public reference page:
`site/reference/creator-engagement.md` in `civitai/civitai-developer-docs` (civitai/civitai-developer-docs#271,
held until the flag opens).

## Request

- **Auth:** a signed-in session, or a full-access personal API key (`Authorization: Bearer …`), via
  `requireFullScopeSession`. Any other bearer credential, such as an OAuth token or a key with a
  narrower scope, gets `403` before the flag or rate limit is checked: no read scope maps to
  engagement counts or tipped Buzz yet. There is no `userId` or `username` parameter: the owner is
  always the authenticated user, and any such parameter is ignored.
- **Flag:** `creatorEngagementApi` (`availability: ['mod']`, Flipt key `creator-engagement-api`).
  When it is off for the caller the route answers `404 { error: 'Not Found' }` rather than 403, so a
  signed-in caller outside the cohort learns nothing about the route. An unauthenticated request
  still gets `AuthedEndpoint`'s 401 first.
- **Query:**

  | Param    | Values                                     | Default      |
  | -------- | ------------------------------------------ | ------------ |
  | `type`   | `image`, `video`, `model`                  | all three    |
  | `sort`   | `engagement`, `newest`                     | `engagement` |
  | `limit`  | 1–100                                      | 20           |
  | `cursor` | `metadata.nextCursor` of the previous page | —            |

- **Rate limit:** 30 requests per minute per user (fixed window in Redis, fails open), on top of
  whatever applies to every API-key request. Over it: `429` with `Retry-After`.
- **Cache:** responses are `private, no-store`. The `sort=engagement` ranking is cached in Redis for
  5 minutes per caller and `type`; the counters on each page are read fresh.

## Response

```json
{
  "items": [
    {
      "id": 1234,
      "type": "image",
      "name": null,
      "url": "https://civitai.com/images/1234",
      "mediaUrl": "https://…",
      "createdAt": "2026-10-01T12:00:00.000Z",
      "nsfwLevel": 1,
      "d7": {
        "reactions": { "total": 3, "like": 2, "heart": 1, "laugh": 0, "cry": 0 },
        "comments": 1,
        "collects": 0,
        "views": 40
      },
      "d30": {
        "reactions": { "total": 9, "like": 6, "heart": 2, "laugh": 1, "cry": 0 },
        "comments": 2,
        "collects": 1,
        "views": 210
      },
      "allTime": {
        "reactions": { "total": 9, "like": 6, "heart": 2, "laugh": 1, "cry": 0 },
        "comments": 2,
        "collects": 1,
        "views": 230,
        "tippedBuzz": 50
      }
    }
  ],
  "metadata": { "nextCursor": "…", "imageCandidates": "reactions-30d" }
}
```

Models carry `versionCount` (published versions), no `mediaUrl`, `reactions` shaped
`{ total, thumbsUp, thumbsDown }`, and `allTime.downloads`. Counts only: no reactor, commenter or
tipper is ever named.

## What each counter means, and where it is read

All Postgres reads go to the read replica (`kyselyRead`) and are keyed by the page's item ids.

| Counter               | Source                      | Windows      | Notes                                                                                                                                                                                                                              |
| --------------------- | --------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image/video reactions | `ImageReaction`             | 7d, 30d, all | Like, Heart, Laugh, Cry; Dislike is not counted. Current reactions whose `createdAt` is in the window: an un-react removes the row, so it leaves every window.                                                                     |
| Model "reactions"     | `ResourceReview`            | 7d, 30d, all | Models have no emoji reactions. `thumbsUp` = recommended reviews, `thumbsDown` = not recommended, `total` = both. `exclude` and ToS-hidden reviews are skipped, as the model metric job does.                                      |
| Comments              | `CommentV3`                 | 7d, 30d, all | Every live comment on the item, replies included; deleted, hidden and ToS-hidden ones are skipped. `CommentV3` is the table the metric jobs count since the comments consolidation; the old `CommentV2`/`Thread` tables are dropped in Phase 6. |
| Collects              | `CollectionItem`            | 7d, 30d, all | `ACCEPTED` entries; each collection the item is in counts once.                                                                                                                                                                    |
| Views (images/videos) | ClickHouse `daily_views`    | 7d, 30d, all | Day-granular: "7d" is the last 7 UTC days including today. Omitted entirely when ClickHouse is unavailable, never reported as 0.                                                                                                   |
| Downloads (models)    | `ModelMetric.downloadCount` | all only     | The windowed ClickHouse rollup was not verified for this endpoint, so `d7`/`d30` carry no `downloads`.                                                                                                                             |
| Tipped Buzz           | `BuzzTip`                   | all only     | `BuzzTip` keeps one row per tipper per item with a running `amount`, so a window cannot be derived from it. `d7`/`d30` carry no `tippedBuzz`.                                                                                      |

**The caller is excluded from every count, in every window including `allTime`:** their own
reactions, reviews, comments and collection entries. The caller's automation may react as the
creator, and an item's numbers should only reflect other people. Accounts suppressed from metrics by
the reaction-abuse detector (`getMetricExcludedUserIds`) are excluded from reactions and reviews, as
the platform's other reaction totals are. Because of both exclusions these numbers can be lower than
the public counts on the item's page.

The Postgres `*Metric` tables were not used for windowed counts: they hold all-time totals only, and
include the creator's own activity. The ClickHouse per-day aggregate (`entityMetricDailyAgg_v2`) was
not used either: it has no reactor id, so it cannot exclude the caller, and its history starts in
November 2025.

## Which items are listed

- Images and videos the caller uploaded, in a published post, scanned (`ingestion = 'Scanned'`), not
  awaiting review and not ToS-removed. Audio is not listed.
- Models the caller owns that are published, not deleted, and not `Private`.

## Sorting and paging

### `sort=newest`

Keyset over `(createdAt DESC, kind, id DESC)` across images and models, with the cursor carrying
that position. Images are walked on `Image (userId, createdAt)`. Models are read through
`Model_userId` and sorted: a creator owns at most ~16k models, so that read stays bounded (54 ms warm
for the largest owner on the dev snapshot) and no new index was added.

A page examines at most 5,000 of the caller's image rows. When `type=video` (or the visibility
filter) leaves fewer than `limit` matches inside that budget, the page comes back **short, possibly
empty, with a `nextCursor`**. Keep following `nextCursor` until it is `null`; an empty page is not
the end.

### `sort=engagement`

Ranked by the 30-day score `d30.reactions.total + d30.comments + d30.collects`, ties broken models
first, then newest id. Only items with a score above 0 are listed, and at most 1,000.

Ranking every item a creator owns would scan their whole history, so the ranking is built from a
bounded candidate set:

1. **Images:** the caller's up to 1,000 images with the most net reactions from other people in the
   last 30 days, from ClickHouse `reactions` (filtered on `ownerId`, the reactor `userId`, and a
   30-day `time` bound). This list is cached per owner for 5 minutes and shared by the all, image
   and video rankings, so one scan serves all three. If ClickHouse is unavailable, the caller's 500
   newest listed images instead, and `metadata.imageCandidates` says `newest`.
2. **Models:** the caller's 500 newest listed models.
3. Each candidate's exact 30-day score is computed in Postgres (the page-counter queries, bounded
   to rows from the last 30 days), the list is sorted and cached for 5 minutes per owner and type.

So an image whose only recent engagement is comments or collects, with no reaction, is not ranked,
and neither is a model older than the creator's 500 newest. Each id from ClickHouse, the cache or a
cursor is re-checked against the caller's ownership in Postgres before it is returned; a forged
cursor only moves the position inside the caller's own ranking.

## Cost

Measured on the dev database (a recent production-sized snapshot) through the service, pages of 100,
Postgres only: there is no ClickHouse locally, so rankings used the `newest` candidate fallback and
views were omitted. "Largest" is the account with the most images and models (~900k images, ~15.7k
models); "mid" owns ~1k models. 20 timed runs after one warm-up, either re-reading the first page or
walking 20 pages by cursor.

| Shape                                              | Largest p50 / p95 / max          | Mid p50 / p95 / max |
| -------------------------------------------------- | -------------------------------- | ------------------- |
| `sort=newest`, all types                           | 59 / 88 / 109 ms                 | 26 / 39 / 43 ms     |
| `sort=newest&type=model`                           | 61 / 86 / 86 ms                  | 22 / 37 / 40 ms     |
| `sort=newest&type=video` (sparse matches)          | 121 / 174 / 284 ms               | 83 / 126 / 139 ms   |
| `sort=engagement`, ranking cached                  | 26 / 44 / 46 ms                  | 27 / 33 / 42 ms     |
| `sort=engagement`, ranking rebuilt (cold, one run) | 538 ms (images), 172 ms (models) | 130 / 106 ms        |

Every per-page counter query is an index scan keyed by the page's ids (`ImageReaction` unique key,
`CommentV3` entity index, `CollectionItem` image/model index, `BuzzTip` primary key,
`ResourceReview (modelId, userId)`), 1–70 ms each for a page of the largest owner. The ranking's
Postgres cost scales with the engagement its candidates received, not with catalogue size. The
ClickHouse reads were measured once each against production for the owner with the most images
(2026-11-05):

| Query                                             | Index pruning                                                      | Rows read       | Elapsed | Memory |
| ------------------------------------------------- | ------------------------------------------------------------------ | --------------- | ------- | ------ |
| `reactions` candidates (30-day window, top 1,000) | primary key `(time, userId)`: 17/147 parts, 2,693/107,399 granules | 22.3 M (378 MB) | 0.70 s  | 219 MB |
| `daily_views` for a page of 100 images            | primary key `(entityType, entityId)`: 16/225,907 granules          | 131 K (1.3 MB)  | 0.09 s  | 47 MB  |

`ownerId` is not in the `reactions` sort key, so the candidate read prunes on `time` only: it reads
every reaction from the last 30 days, and its cost scales with site-wide activity rather than with
the owner's catalogue. It runs at most once per owner per 5-minute candidate cache, whatever the
`type`. That is acceptable while the flag is mod-only. The read must be bounded before the flag
widens, which is tracked as a follow-up.

## Tests

- `src/server/services/__tests__/creator-engagement.sql.behavior.test.ts` runs the service's SQL
  against PGlite: ownership, forged cursors, self and suppressed-reactor exclusion, window edges,
  cursor stability, the scan budget, and the ClickHouse fallback.
- `src/tests/api/v1/creator/engagement.test.ts`: flag off, caller scoping, limits, rate limit.
