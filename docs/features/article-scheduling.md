# Article scheduling

An author picks a time in the article editor and the article goes live then without anyone pressing
Publish. Behind the `articleScheduling` flag (Flipt `article-scheduling`, fallback `['mod']`).

## How it works

- A scheduled article is a plain **Draft** with `Article.scheduledAt` set. `publishedAt` stays NULL
  until go-live, so every rule that hides a draft (feeds, search, sitemap, direct link for
  non-owners, follower notifications) hides it without knowing about scheduling.
- `process-scheduled-publishing` (every minute) calls `publishDueScheduledArticles`. For each Draft
  with `scheduledAt <= now` it reads the scan state:
  - `Scanned`: Published, `publishedAt` = the go-live instant, then the manual-publish side effects
    (engagement, search index, count cache, owner notification). Follower notifications key on
    `publishedAt`, so they fire now and not at schedule time.
  - `Pending` / `Rescan`: Processing; the ingestion recompute publishes it when the scan settles.
  - `Blocked` / `Error`: the schedule is dropped, the article stays a Draft and the owner is told.
  - Author banned, muted or deleted since scheduling: the schedule is dropped, nothing is sent.
- Each job write re-checks the state it was decided on, so a cancel or edit racing the job wins.
  The editor's save is guarded the other way: a never-published draft is written only while it is
  still one, so a save that read it just before go-live fails with "reload" instead of un-publishing it.
- Only a never-published Draft can be scheduled: a republish keeps its original `publishedAt`, so a
  scheduled republish would surface at the old date. Same window as posts: 10 minutes to 3 months
  ahead, picked in the author's local time and stored as an instant.
- Publishing now, or saving with `scheduledAt: null`, cancels the schedule. A plain save leaves it.

## Key files

| File                                                | Purpose                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| `src/server/services/article-schedule.helpers.ts`   | `getArticleScheduleError`, `getScheduledArticleGoLive` (pure)        |
| `src/server/services/article-schedule.service.ts`   | `publishDueScheduledArticles`, run by `process-scheduled-publishing` |
| `src/server/services/article.service.ts`            | `upsertArticle` takes `scheduledAt` (date schedules, null cancels)   |
| `src/components/Article/ArticleUpsertForm.tsx`      | Schedule / Reschedule / Cancel schedule; `SchedulePostModal` with `entity="article"`|
