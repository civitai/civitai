/**
 * The tag that marks an article as published by Civitai rather than by a community
 * author, and the one place its name is written down.
 *
 * It is a TAG and not a category on purpose: an article carries exactly one category
 * (`ArticleUpsertForm` makes the author pick one), and official articles span several of
 * them — an official announcement and an official guide are both official. A category
 * could not say both things at once.
 *
 * 🔴 The authority behind this badge is `Tag.adminOnly` plus the guard in
 * `upsertArticleHandler`, NOT this constant. Article tags attach by NAME through
 * `connectOrCreate`, so anything that can send a tag name can ask for this one; what stops
 * it is the server refusing an `adminOnly` tag from a caller without the `adminTags`
 * feature. If you are adding a second surface that reads this badge, you are relying on
 * that guard — do not add a path that trusts the name alone on the way IN.
 *
 * 🔴 And the tag row itself is the other half: renaming the tag in the database, or
 * clearing its `adminOnly`, silently changes what this badge means without touching a
 * line of code. The row is created by
 * `prisma/sql-migrations/2026-09-04-civitai-official-tag.sql`.
 */
export const OFFICIAL_ARTICLE_TAG = 'civitai official';

/** What the badge reads. The tag name carries the brand for moderators picking it out of
 * a tag list; the badge sits next to Civitai's own logo, where repeating it is noise. */
export const OFFICIAL_ARTICLE_LABEL = 'Official';

type MaybeTag = { name?: string | null };

/**
 * Case- and whitespace-insensitive, matching how `article.service` normalises a tag name
 * before `connectOrCreate` — the stored row is lowercase, but a payload is only as clean
 * as the query that built it, and a future caller selecting the raw column should not
 * silently lose the badge.
 */
export const isOfficialArticleTag = (tag: MaybeTag) =>
  tag.name?.toLowerCase().trim() === OFFICIAL_ARTICLE_TAG;

export const hasOfficialArticleTag = (tags?: MaybeTag[] | null) =>
  !!tags?.some(isOfficialArticleTag);
