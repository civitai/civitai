# Writer leaderboards

Four article leaderboards next to the existing Writers and Story Writers boards: Active Writers, Guide
Writers, Rising Writers and Community Builders. Each scores an author's articles one at a time and
lets newer articles count for more. Based on civitai/civitai#6556, which also proposed a Storytellers
board; stories already have the Story Writers board (`story-writer`).

## Why

The Writers board (`writer`) scores `√(views) / 2 + √(reactions) × 7 + √(bookmarks) × 10` on the
totals of an author's articles published in the last 30 days. Until 22 October 2026 it counted every
article ever published, and 52 of its top 100 had published fewer than three articles in the previous
year. The window fixed that. The board still:

- counts the author's own reactions, because it reads them from `ArticleMetric`;
- counts an article in full for 30 days, then not at all;
- scores every kind of article on one formula: simulated on 22 October 2026 data, 33 of its top 100
  were release-note writers, against 16 on Active Writers;
- ignores comments and articles written in answer.

It stays as it is. The new boards are added beside it.

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

Every board counts only articles that pass the Writers board's gates: published, scanned, rated (any
level; an unrated article never counts), not Private, not unlisted, not removed for a terms violation,
and by an owner who is neither deleted nor banned. The same gates apply to the articles counted as
answers.

An article's categories are its system category (`Article.systemCategoryId`) when it has one, and
the categories its author picked (tags under the `article category` system tag) only when it has
none. An article whose categories are all announcement, news or event earns a quarter of the
points on Active Writers, Rising Writers and Community Builders; a guide is an article with a guide,
workflow, data prep, comparative study or ML Research category. "Half-life" is how many days after publishing an article
keeps half its points.

| Board              | Id                 | Per-article value                                                | Half-life | Articles counted                              |
| ------------------ | ------------------ | ---------------------------------------------------------------- | --------- | --------------------------------------------- |
| Active Writers     | `writer-active`    | `√views/2 + √readers×7 + √bookmarks×10 + √participants×5`        | 90 days   | Best 30 from the last 365 days                |
| Guide Writers      | `writer-guide`     | `√views/2 + √bookmarks×12 + √participants×4`, past-year comments | 365 days  | Best 20 guides of any age                     |
| Rising Writers     | `writer-rising`    | `√readers×10 + √views/2`                                         | none      | Best 10                                       |
| Community Builders | `writer-community` | `√participants×6 + √answers×20 + √first-time answers×10`         | 180 days  | Best 10 from the last 365 days                |

The same formulas ship as each board's `scoringDescription` in the migration; change both together.

- **Readers** are distinct people other than the author who reacted to the article
  (`ArticleReaction`). **Participants** are distinct people other than the author who commented
  (`CommentV3` rows on the article, replies included), ignoring deleted, hidden and
  terms-violating comments. Each is counted once per article, and metric-excluded accounts are left
  out of both through the `{{metricExcludedUserIds}}` token (see `METRIC_EXCLUDED_USERS_TOKEN` in
  `leaderboard-board-query.ts`). If that list cannot be fetched, the run proceeds with it empty.
  `ArticleMetric`'s reaction and comment counts include the author's own, so no board reads them;
  views and bookmarks still come from `ArticleMetric`, whose `AllTime` row is the only one the
  article metrics job still writes.
- **Answers** are later articles by other people, published in the last 365 days, that link to the
  article (`/articles/<id>` in the body), each author counted once. A **first-time** answer is one
  that is the answering author's first published article ever. Community Builders lists only authors
  with at least one answer on their counted articles, so comments alone are rewarded on the other
  boards.
- **Guide Writers** counts participants from comments in the past 365 days and needs a guide published
  in that time. Views and bookmarks are all-time; the 365-day half-life is what lets old guides fade.
- **Rising Writers** takes only authors whose first published article is under 90 days old, with 25
  distinct readers across their articles.

## Rollout

The migration inserts the four boards inactive and non-public, on the Writers board's `domain`, as the crucible boards were. Each
query is run read-only first, then `active` and `public` are set together. Badges come in a separate
migration once a board is public.

Order matters both ways, because one board whose query fails stops the whole nightly run: activate
the boards only after the build that replaces `{{metricExcludedUserIds}}` is deployed, and roll them
back before reverting that build. Do not activate while `prepare-leaderboard` or
`update-user-leaderboard-rank` is running; their schedules are in `prepare-leaderboard.ts`.

The rollback is the `ROLLBACK` block in the migration header. It refuses to run while a badge for one
of the boards exists, then removes the boards with their results, Legends rows and populated
markers, and rebuilds the affected users' ranks from the remaining public boards. Afterwards purge
the `leaderboard` cache tag, or wait for `clear-leaderboard-cache` at midnight. To keep the history
instead, set `active = false` and `public = false`; Legends still counts a hidden board's past
results.

## Key Files

| File                                                                                            | What it holds                                                 |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/civitai-db-schema/prisma/migrations/20261120180000_writer_leaderboards/migration.sql` | The four `Leaderboard` rows, their queries and the rollback   |
| `src/server/jobs/prepare-leaderboard.ts`                                                        | Runs the queries                                              |
| `src/server/jobs/leaderboard-board-query.ts`                                                    | Replaces `{{metricExcludedUserIds}}`                          |
| `src/components/Leaderboard/LeaderboardMetrics.tsx`                                             | Icons for the metrics the new boards report                   |
| `src/server/jobs/__tests__/writer-leaderboards.behavior.test.ts`                                | Runs each query and the rollback from the migration on PGlite |
