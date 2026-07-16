import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { toJson } from './infra/helpers';

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
export function setArticleIngestion(
  db: Kysely<DB>,
  input: { id: number; ingestion: ArticleIngestionValue; contentScannedAt?: Date }
) {
  return db
    .updateTable('Article')
    .set({
      ingestion: sql<ArticleIngestionValue>`${input.ingestion}::"ArticleIngestionStatus"`,
      ...(input.contentScannedAt ? { contentScannedAt: input.contentScannedAt } : {}),
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
