import { sql, type Kysely, type Selectable, type Updateable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { toJson } from './infra/helpers';
import { keepUpdatedAt } from './infra/updated-at-plugin';

// Generic single-article update. The caller passes the id plus whichever columns to set; `updatedAt` is stamped
// automatically (Article is a Prisma `@updatedAt` column with no DB trigger). Prefer this over a narrow
// single-column setter; keep a named function only for a multi-column semantic transition or one that needs a
// jsonb/CASE/raw expression (the restore/unpublish/ingestion/nsfw writes below). Returns the updated row.
export function updateArticle(db: Kysely<DB>, input: Updateable<DB['Article']> & { id: number }) {
  const { id, ...data } = input;
  return db
    .updateTable('Article')
    .set({ ...data })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

// Enum values derived from the schema (unwrapping `Generated<…>` via `Selectable`) so this module needs no
// separate enum import and no moderator-app type import.
type ArticleStatusValue = Selectable<DB['Article']>['status'];
type ArticleIngestionValue = Selectable<DB['Article']>['ingestion'];
type MediaTypeValue = Selectable<DB['Image']>['type'];

// Articles awaiting a moderator decision: unpublished by a moderator, or auto-unpublished for a violation.
const UNPUBLISHED: ArticleStatusValue[] = ['Unpublished', 'UnpublishedViolation'];

export type ModeratorArticleRow = {
  id: number;
  title: string;
  status: ArticleStatusValue;
  createdAt: Date | null;
  publishedAt: Date | null;
  metadata: unknown;
  coverUrl: string | null;
  coverType: MediaTypeValue | null;
  username: string | null;
  userImage: string | null;
};

// A page of moderator-queue articles, newest first, with cover (left-joined Image) and author (User). When a
// `status` is given it filters to exactly that status, otherwise to the unpublished set; an optional username
// substring narrows by author. Runs a count then the items query and returns both for pagination.
export async function getArticlesForModeration(
  db: Kysely<DB>,
  {
    page = 1,
    limit = 20,
    username,
    status,
  }: {
    page?: number;
    limit?: number;
    username?: string;
    status?: ArticleStatusValue;
  }
): Promise<{ items: ModeratorArticleRow[]; totalItems: number; page: number; limit: number }> {
  const offset = (page - 1) * limit;

  let base = db
    .selectFrom('Article')
    .innerJoin('User', 'User.id', 'Article.userId')
    .leftJoin('Image', 'Image.id', 'Article.coverId')
    .where('Article.status', 'in', status ? [status] : UNPUBLISHED);
  if (username) base = base.where('User.username', 'ilike', `%${username}%`);

  const totalItems = Number(
    (await base.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirst())?.count ?? 0
  );

  const items = (await base
    .select([
      'Article.id',
      'Article.title',
      'Article.status',
      'Article.createdAt',
      'Article.publishedAt',
      'Article.metadata',
      'Image.url as coverUrl',
      'Image.type as coverType',
      'User.username',
      'User.image as userImage',
    ])
    .orderBy('Article.createdAt', 'desc')
    .limit(limit)
    .offset(offset)
    .execute()) as ModeratorArticleRow[];

  return { items, totalItems, page, limit };
}

// Sidebar-badge count: all unpublished articles awaiting a moderator decision (no username filter).
export async function countArticlesForModeration(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom('Article')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('status', 'in', UNPUBLISHED)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

// ---------------------------------------------------------------------------------------------------------
// Restore — the DB statements of the app's internal `restoreArticle`. The orchestration (metadata cleanup,
// computing the next ingestion state from the reads below) stays in the caller; each statement here is a pure
// query so it EXPLAINs independently. The caller composes them in a transaction.
// ---------------------------------------------------------------------------------------------------------

// The article fields needed to restore it and recompute its ingestion state. Read; throws in the caller when
// absent / not unpublished.
export function getArticleForRestore(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('Article')
    .select([
      'status',
      'publishedAt',
      'metadata',
      'userId',
      'coverId',
      'title',
      'content',
      'ingestion',
    ])
    .where('id', '=', id)
    .executeTakeFirst();
}

// The owner/publish-state fields the unpublish flow reads.
export function getArticleForUnpublish(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('Article')
    .select(['userId', 'publishedAt', 'status'])
    .where('id', '=', id)
    .executeTakeFirst();
}

// Article fields needed to re-link images and re-moderate text on a rescan.
export function getArticleForRescan(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('Article')
    .select(['id', 'userId', 'content', 'title', 'coverId'])
    .where('id', '=', id)
    .executeTakeFirst();
}

// Flip an article back to Published: keep the original publishedAt so a restored article doesn't jump to the
// top of the feed, and write the caller-cleaned metadata as jsonb.
export function setArticleRestored(
  db: Kysely<DB>,
  input: { id: number; publishedAt: Date; metadata: unknown }
) {
  return db
    .updateTable('Article')
    .set({
      status: 'Published',
      publishedAt: input.publishedAt,
      metadata: toJson(input.metadata),
    })
    .where('id', '=', input.id)
    .execute();
}

// Re-derive Article.nsfwLevel (ported from updateArticleNsfwLevels): GREATEST of the scanned cover/content
// image levels and a moderation floor (an EntityModeration nsfw/blocked hit or an Actioned NSFW report),
// with a moderator override still winning. Only rewrites rows whose derived level actually changed.
export function refreshArticleNsfwLevel(db: Kysely<DB>, id: number) {
  return sql`
      WITH level AS (
        SELECT a.id, GREATEST(
          COALESCE(max(cover."nsfwLevel"), 0),
          COALESCE(max(content_imgs."nsfwLevel"), 0)
        ) AS "nsfwLevel"
        FROM "Article" a
        LEFT JOIN "Image" cover
          ON a."coverId" = cover.id AND cover."ingestion" IN ('Scanned', 'Blocked')
        LEFT JOIN "ImageConnection" ic
          ON ic."entityId" = a.id AND ic."entityType" = 'Article'
        LEFT JOIN "Image" content_imgs
          ON ic."imageId" = content_imgs.id AND content_imgs."ingestion" = 'Scanned'
        WHERE a.id = ${id}
        GROUP BY a.id
      ),
      moderation_floor AS (
        SELECT a.id, CASE
          WHEN EXISTS (
            SELECT 1 FROM "EntityModeration" em
            WHERE em."entityType" = 'Article' AND em."entityId" = a.id
              AND em.status = 'Succeeded'::"EntityModerationStatus"
              AND (em.blocked = TRUE OR 'nsfw' = ANY(em."triggeredLabels"))
          ) OR EXISTS (
            SELECT 1 FROM "ArticleReport" ar
            JOIN "Report" r ON r.id = ar."reportId"
            WHERE ar."articleId" = a.id
              AND r.reason = 'NSFW'::"ReportReason" AND r.status = 'Actioned'::"ReportStatus"
          ) THEN 4 ELSE 0
        END AS "floor"
        FROM "Article" a
        WHERE a.id = ${id}
      )
      UPDATE "Article" a
      SET "nsfwLevel" = COALESCE(
        a."moderatorNsfwLevel",
        GREATEST(a."userNsfwLevel", level."nsfwLevel", mf."floor")
      )
      FROM level JOIN moderation_floor mf ON mf.id = level.id
      WHERE level.id = a.id
        AND COALESCE(
          a."moderatorNsfwLevel",
          GREATEST(a."userNsfwLevel", level."nsfwLevel", mf."floor")
        ) != a."nsfwLevel"
    `.execute(db);
}

// Ingestion states of an article's content images (via ImageConnection). Read.
export function getArticleContentImageIngestion(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('ImageConnection as ic')
    .innerJoin('Image as i', 'i.id', 'ic.imageId')
    .select('i.ingestion')
    .where('ic.entityId', '=', id)
    .where('ic.entityType', '=', 'Article')
    .execute();
}

// Ingestion state of an article's cover image. Read.
export function getArticleCoverIngestion(db: Kysely<DB>, coverId: number) {
  return db.selectFrom('Image').select('ingestion').where('id', '=', coverId).executeTakeFirst();
}

// The article's text-moderation verdict (EntityModeration row). Read.
export function getArticleTextModeration(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('EntityModeration')
    .select(['status', 'blocked'])
    .where('entityType', '=', 'Article')
    .where('entityId', '=', id)
    .executeTakeFirst();
}

// Set the recomputed ingestion state; stamp contentScannedAt when the caller says it just reached Scanned.
// Like setArticleIngestionState, the source (`recomputeArticleIngestion`) wrote this via raw `$executeRaw`
// precisely to dodge the `@updatedAt` bump (a scan recompute must not reorder "Recently Updated") — preserved
// here via keepUpdatedAt.
export function setArticleIngestion(
  db: Kysely<DB>,
  input: { id: number; ingestion: ArticleIngestionValue; contentScannedAt?: Date }
) {
  return db
    .updateTable('Article')
    .set({
      ingestion: sql<ArticleIngestionValue>`${input.ingestion}::"ArticleIngestionStatus"`,
      ...(input.contentScannedAt ? { contentScannedAt: input.contentScannedAt } : {}),
      updatedAt: keepUpdatedAt,
    })
    .where('id', '=', input.id)
    .execute();
}

// ---------------------------------------------------------------------------------------------------------
// Delete — the DB statements of the app's internal `deleteArticle` transaction. Each delete is a pure,
// EXPLAIN-testable statement; `deleteArticle` runs the three in one transaction. The deferred cover/orphaned-
// content image cleanup (DB + S3 + CDN) is intentionally SKIPPED.
// ---------------------------------------------------------------------------------------------------------

export function deleteArticleFiles(db: Kysely<DB>, id: number) {
  return db
    .deleteFrom('File')
    .where('entityId', '=', id)
    .where('entityType', '=', 'Article')
    .execute();
}

export function deleteArticleImageConnections(db: Kysely<DB>, id: number) {
  return db
    .deleteFrom('ImageConnection')
    .where('entityId', '=', id)
    .where('entityType', '=', 'Article')
    .execute();
}

export function deleteArticleRecord(db: Kysely<DB>, id: number) {
  return db.deleteFrom('Article').where('id', '=', id).execute();
}

// Remove an article and its file/image connections in one transaction.
export function deleteArticle(db: Kysely<DB>, id: number) {
  return db.transaction().execute(async (trx) => {
    await deleteArticleFiles(trx, id);
    await deleteArticleImageConnections(trx, id);
    await deleteArticleRecord(trx, id);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Unpublish — the DB statements of the app's `unpublishArticleById`. The metadata merge (unpublish reason,
// timestamps) and the Published-state guard stay in the caller; each statement here is a pure query. The
// caller composes the read + write in a transaction.
// ---------------------------------------------------------------------------------------------------------

// The article fields needed to authorize + validate an unpublish (owner check, must currently be Published).

// Flip an article to the caller-computed unpublished status and write the caller-merged metadata as jsonb.
// This mirrors a plain Prisma `update()`, whose `@updatedAt` bumps `updatedAt` — auto-stamped here by the
// @updatedAt plugin. This is the intentional opposite of the rescan/ingestion writes below, which must NOT
// touch `updatedAt` (they opt out via keepUpdatedAt).
export function setArticleUnpublished(
  db: Kysely<DB>,
  input: { id: number; status: ArticleStatusValue; metadata: unknown }
) {
  return db
    .updateTable('Article')
    .set({
      status: input.status,
      metadata: toJson(input.metadata),
    })
    .where('id', '=', input.id)
    .execute();
}

// ---------------------------------------------------------------------------------------------------------
// Rescan — the DB statements of the app's `rescanArticle`. The rate-limit (Redis), image re-ingestion enqueue,
// text-moderation resubmit, and search-index sync are all side effects left to the caller; the DB core is the
// article read, the ingestion-reset write, and the content-image read that feeds the re-queue.
// ---------------------------------------------------------------------------------------------------------

// The article fields needed to drive a rescan (owner for enqueue attribution, content/title for text
// re-moderation, coverId for image re-linking). Read.

// Reset ingestion to Rescan, stamp scanRequestedAt, and clear contentScannedAt so the normal webhook flow
// drives the article back to a terminal state. The source used raw `$executeRaw` purely to dodge Prisma's
// `@updatedAt` bump (a rescan is not a user-edit and must not reorder the "Recently Updated" feed); with the
// updatedAt plugin installed we preserve that intent by self-referencing `updatedAt` (keepUpdatedAt).
export function setArticleRescanRequested(db: Kysely<DB>, id: number) {
  return db
    .updateTable('Article')
    .set({
      ingestion: sql<ArticleIngestionValue>`'Rescan'::"ArticleIngestionStatus"`,
      scanRequestedAt: new Date(),
      contentScannedAt: null,
      updatedAt: keepUpdatedAt,
    })
    .where('id', '=', id)
    .execute();
}

// An article's content images (via ImageConnection) with the fields the rescan re-queue needs. Read.
export function getArticleContentImages(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('ImageConnection as ic')
    .innerJoin('Image as i', 'i.id', 'ic.imageId')
    .select(['i.id', 'i.url', 'i.ingestion', 'i.type'])
    .where('ic.entityId', '=', id)
    .where('ic.entityType', '=', 'Article')
    .execute();
}

// ---------------------------------------------------------------------------------------------------------
// Ingestion recompute — the DB statements of `recomputeArticleIngestionInTx`. The state derivation (counting
// image/text terminal states, choosing the next ingestion enum, deciding the Processing→Published flip) is
// pure JS and stays in the caller, reading via the existing `getArticleForRestore` (a superset of the fields it needs),
// `getArticleContentImageIngestion`, `getArticleCoverIngestion`, and
// `getArticleTextModeration`. What's genuinely new here is the advisory lock and the combined ingestion/publish
// write.
// ---------------------------------------------------------------------------------------------------------

// Serialize concurrent recomputes for one article: a transaction-scoped advisory lock keyed on the article id.
// Meaningful only inside a transaction (xact lock releases on commit) — pass the same `trx` as the writes.
export function lockArticleForIngestion(db: Kysely<DB>, id: number) {
  return sql`SELECT pg_advisory_xact_lock(${id})`.execute(db);
}

// Write the recomputed ingestion state in one statement: always the ingestion enum; contentScannedAt when the
// article just reached Scanned; and — when the article flips Processing→Published — status + the preserved
// publishedAt together (passing publishedAt is the flip signal). Like the rescan write, the source used raw
// `$executeRaw` only to avoid the `@updatedAt` bump, preserved here via keepUpdatedAt. Supersedes the simpler
// `setArticleIngestion` for the recompute path (that one has no publish flip).
export function setArticleIngestionState(
  db: Kysely<DB>,
  input: {
    id: number;
    ingestion: ArticleIngestionValue;
    contentScannedAt?: Date;
    publishedAt?: Date;
  }
) {
  return db
    .updateTable('Article')
    .set({
      ingestion: sql<ArticleIngestionValue>`${input.ingestion}::"ArticleIngestionStatus"`,
      ...(input.contentScannedAt ? { contentScannedAt: input.contentScannedAt } : {}),
      ...(input.publishedAt ? { status: 'Published', publishedAt: input.publishedAt } : {}),
      updatedAt: keepUpdatedAt,
    })
    .where('id', '=', input.id)
    .execute();
}

// Bulk nsfwLevel re-derive (ported from `updateArticleNsfwLevels`): the many-id + RETURNING variant of
// `refreshArticleNsfwLevel`. Same GREATEST(cover, content, moderation-floor) derivation with the moderator
// override winning; RETURNs the ids whose derived level actually changed (the caller uses them to sync the
// search index — that side effect is dropped here). Guarded against an empty id list (raw `IN ()` is a syntax
// error).
export async function refreshArticleNsfwLevelMany(db: Kysely<DB>, articleIds: number[]) {
  if (!articleIds.length) return { rows: [] as { id: number }[] };
  return sql<{ id: number }>`
      WITH level AS (
        SELECT a.id, GREATEST(
          COALESCE(max(cover."nsfwLevel"), 0),
          COALESCE(max(content_imgs."nsfwLevel"), 0)
        ) AS "nsfwLevel"
        FROM "Article" a
        LEFT JOIN "Image" cover
          ON a."coverId" = cover.id AND cover."ingestion" IN ('Scanned', 'Blocked')
        LEFT JOIN "ImageConnection" ic
          ON ic."entityId" = a.id AND ic."entityType" = 'Article'
        LEFT JOIN "Image" content_imgs
          ON ic."imageId" = content_imgs.id AND content_imgs."ingestion" = 'Scanned'
        WHERE a.id IN (${sql.join(articleIds)})
        GROUP BY a.id
      ),
      moderation_floor AS (
        SELECT a.id, CASE
          WHEN EXISTS (
            SELECT 1 FROM "EntityModeration" em
            WHERE em."entityType" = 'Article' AND em."entityId" = a.id
              AND em.status = 'Succeeded'::"EntityModerationStatus"
              AND (em.blocked = TRUE OR 'nsfw' = ANY(em."triggeredLabels"))
          ) OR EXISTS (
            SELECT 1 FROM "ArticleReport" ar
            JOIN "Report" r ON r.id = ar."reportId"
            WHERE ar."articleId" = a.id
              AND r.reason = 'NSFW'::"ReportReason" AND r.status = 'Actioned'::"ReportStatus"
          ) THEN 4 ELSE 0
        END AS "floor"
        FROM "Article" a
        WHERE a.id IN (${sql.join(articleIds)})
      )
      UPDATE "Article" a
      SET "nsfwLevel" = COALESCE(
        a."moderatorNsfwLevel",
        GREATEST(a."userNsfwLevel", level."nsfwLevel", mf."floor")
      )
      FROM level JOIN moderation_floor mf ON mf.id = level.id
      WHERE level.id = a.id
        AND COALESCE(
          a."moderatorNsfwLevel",
          GREATEST(a."userNsfwLevel", level."nsfwLevel", mf."floor")
        ) != a."nsfwLevel"
      RETURNING a.id
    `.execute(db);
}

export function deleteArticleForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('Article').where('userId', '=', userId).execute();
}

export function deleteArticleReactionForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('ArticleReaction').where('userId', '=', userId).execute();
}
