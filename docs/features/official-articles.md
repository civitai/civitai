# Official articles

An article "published by Civitai" is marked by `Article.isOfficial`. The column is the source of
truth; everything else is derived from it.

## What the mark does

- **Badge** — `OfficialArticleBadge` on the card and the article page.
- **Tag** — the article carries the `civitai official` tag (`OFFICIAL_ARTICLE_TAG` in
  `src/shared/constants/article.constants.ts`). `article.service` writes the tag whenever the column
  changes and strips it from any client-supplied tag list, so the tag is never attached by hand.
- **Feed chip** — the tag leads the category row above `/articles` and filters with `?tags=<id>`
  like any other chip. The row fetches it through `article.getOfficialTag` because `tag.getAll`
  hides `adminOnly` tags from non-admins and the tag is not an article category (an article has
  exactly one of those).

## Who can mark

Moderators only, from the article context menu (`article.setOfficial`) or the "Official Civitai
article" switch in the editor. The editor drops the field for anyone else rather than refusing the
save, so an owner editing an article a moderator marked keeps the mark and their save.

## The tag row

The code tolerates the tag not existing: the mark still writes the column and the badge, and the
chip is simply absent. The row is seeded by hand, once per database, after this code is deployed
and in this order:

1. Upsert the tag named `civitai official` to `type = System`, `adminOnly = true`, target Article.
   An upsert, not an insert: a `UserGenerated` row with that name may already exist, and
   `getSystemTags` only sees `System` rows.
2. Insert `TagsOnArticle` rows for every article with `isOfficial`.
3. Delete the Redis key `system:tags` (`getSystemTags` caches for four hours) and wait a minute
   for the per-pod memo to turn over.
4. Delete the tag's rows from every article without `isOfficial`. Last, so nothing written
   against the stale tag list survives.

`article.getOfficialTag` is edge-cached for an hour, so the chip appears within the hour.

`/events` redirects to `/articles` (the old Events-collection page is gone).
