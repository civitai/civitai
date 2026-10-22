# Writer leaderboards

Four article leaderboards next to the existing Writers board: Active Writers, Storytellers, Guide
Writers and Rising Writers. Each scores an author's articles one at a time and lets newer articles
count for more.

## Why

The Writers board (`writer`) scores `√(views) / 2 + √(reactions) × 7 + √(bookmarks) × 10` on an
author's totals. Taking the square root of totals means article count barely matters, and nothing
loses value with age: on 22 October 2026, 52 of its top 100 had published fewer than three articles
in the previous year. It stays exactly as it is, as the all-time board. The new boards are added
beside it.

## Who writes

Public articles in the 12 months to 22 October 2026: 11,780 articles from 2,782 authors. Leaving out
articles whose only categories are announcement, news or event, 1,836 people published at least one
article, 533 published three or more, 101 published twelve or more and 15 published 52 or more.

Authors with three or more articles in that year, grouped by the category family that makes up at
least half of their articles:

| Group                                                                   | Authors | Articles | What sets them apart                                                                                |
| ----------------------------------------------------------------------- | ------- | -------- | --------------------------------------------------------------------------------------------------- |
| Storytellers (`story`)                                                  | 159     | 2,127    | The most reactions per article and the shortest gap between articles; almost no bookmarks           |
| Guide writers (the guide, workflow, comparison and research categories) | 202     | 1,561    | The most views per article and the only group that gets bookmarked; most publish a few times a year |
| Essayists (`musing`)                                                    | 75      | 614      | Small and occasional                                                                                |
| Mixed (no family reaches half)                                          | 65      | 1,275    | Few people, some of the most prolific                                                               |
| Release-note writers (announcements, with models)                       | 254     | 2,896    | Model creators announcing their own releases; the largest output                                    |
| Announcers (announcements, no models)                                   | 104     | 618      | The fewest views per article                                                                        |

## The boards

Every board counts only articles that are published, public, listed and not removed for a terms
violation. An article whose only categories are announcement, news or event earns a quarter of the
points on Active Writers and Rising Writers. "Half-life" is how many days after publishing an article
keeps half its points.

| Board          | Id              | Per-article value                                                   | Half-life | Articles counted                              |
| -------------- | --------------- | ------------------------------------------------------------------- | --------- | --------------------------------------------- |
| Active Writers | `writer-active` | `√views/2 + √reactions×7 + √bookmarks×10 + √comments×5`             | 90 days   | Best 30 from the last 365 days                |
| Storytellers   | `writer-story`  | `√readers×7 + √comments×10 + √bookmarks×5 + √views/4`               | 90 days   | Best 20 story articles from the last 365 days |
| Guide Writers  | `writer-guide`  | `√views/2 + √bookmarks×12 + √comments×4`, past-year engagement only | 365 days  | Best 20 guides of any age                     |
| Rising Writers | `writer-rising` | `√readers×10 + √views/2`                                            | none      | Best 10                                       |

The same formulas ship as each board's `scoringDescription` in the migration; change both together.

- **Storytellers** adds `√(loyal readers) × 15`, where a loyal reader reacted to three or more of the
  author's chapters in the last 90 days, and multiplies the total by `0.5 + 0.5 × weeks / 12`, where
  `weeks` is the number of the last 12 weeks with a new chapter.
- **Guide Writers** reads the `Year` row of `ArticleMetric`, which counts only engagement from the past
  365 days, and needs a guide published in that time.
- **Rising Writers** takes only authors whose first published article is under 90 days old, with 25
  distinct readers across their articles.
- **Readers** are distinct people who reacted, counted from `ArticleReaction`, minus the author and the
  metric-excluded accounts. The queries use the `{{metricExcludedUserIds}}` token; see
  `METRIC_EXCLUDED_USERS_TOKEN` in `prepare-leaderboard.ts`.

## Rollout

The migration inserts the four boards inactive and non-public, as the crucible boards were. Each
query is run read-only first, then `active` and `public` are set together. Badges come in a separate
migration once a board is public.

Order matters both ways, because one board whose query fails stops the whole nightly run: activate
the boards only after the build that replaces `{{metricExcludedUserIds}}` is deployed, and roll them
back before reverting that build. The rollback is the `ROLLBACK` block in the migration header. It
removes the boards and everything they produced, and rebuilds the affected users' ranks from the
boards that remain.

## Key Files

| File                                                                                            | What it holds                                                                 |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/civitai-db-schema/prisma/migrations/20261022170000_writer_leaderboards/migration.sql` | The four `Leaderboard` rows and their queries                                 |
| `src/server/jobs/prepare-leaderboard.ts`                                                        | Runs the queries; replaces `{{metricExcludedUserIds}}`                        |
| `src/components/Leaderboard/LeaderboardMetrics.tsx`                                             | Icons for the `articles`, `readers`, `loyalReaders` and `activeWeeks` metrics |
| `src/server/jobs/__tests__/writer-leaderboards.behavior.test.ts`                                | Runs each query from the migration through the job on PGlite                  |
