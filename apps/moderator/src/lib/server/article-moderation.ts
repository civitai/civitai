import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS } from '@civitai/redis';
import { dbWrite } from './db';
import { bustCachedObject } from './cache';
import { syncSearchIndex } from './search-index';
import { ArticleStatus, type ArticleMetadata } from '$lib/articles';

type ModerateResult = { ok: true } | { ok: false; error: string };

const UNPUBLISHED: ArticleStatus[] = [
  ArticleStatus.Unpublished,
  ArticleStatus.UnpublishedViolation,
];

// Restore or delete an article. The DB mutations run INTERNALLY via Kysely; the only main-app hit is the
// Meilisearch enqueue. Restore is faithful (status + nsfwLevel re-derive + ingestion recompute +
// userArticleCountCache bust). Delete's cover/orphaned-content image cleanup (DB + S3 + CDN) is still
// deferred — it needs the @civitai/storage client that isn't wired yet (see the TODO in deleteArticle).
export async function moderateArticle(input: {
  action: 'restore' | 'delete';
  articleId: number;
  // Acting moderator — access is already enforced globally; kept for parity / future audit.
  userId: number;
}): Promise<ModerateResult> {
  try {
    if (input.action === 'restore') await restoreArticle(input.articleId);
    else await deleteArticle(input.articleId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  void syncSearchIndex({
    entityType: 'article',
    entityId: input.articleId,
    action: input.action === 'delete' ? 'delete' : 'update',
  });

  return { ok: true };
}

async function restoreArticle(id: number): Promise<void> {
  const userId = await dbWrite.transaction().execute(async (trx): Promise<number> => {
    const article = await trx
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
    if (!article) throw new Error(`No article with id ${id}`);
    if (!UNPUBLISHED.includes(article.status as ArticleStatus))
      throw new Error('Article is not unpublished');

    const meta = { ...((article.metadata as ArticleMetadata) ?? {}) } as Record<string, unknown>;
    delete meta.unpublishedReason;
    delete meta.customMessage;
    delete meta.unpublishedAt;
    delete meta.unpublishedBy;

    await trx
      .updateTable('Article')
      .set({
        status: ArticleStatus.Published,
        // Preserve the original publishedAt so a restored article doesn't bump to the top of the feed.
        publishedAt: article.publishedAt ?? new Date(),
        metadata: sql`${JSON.stringify(meta)}::jsonb`,
      })
      .where('id', '=', id)
      .execute();

    // Re-derive nsfwLevel (ported from updateArticleNsfwLevels) so a cover raised to X/Blocked while the
    // article sat unpublished can't leak into an SFW feed on republish. A moderator override still wins.
    await sql`
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
    `.execute(trx);

    // Re-derive Article.ingestion from ground truth (content/cover image scan states + text moderation),
    // ported from recomputeArticleIngestionInTx. The legacy also flips status + notifies the owner, but
    // both are gated on status='Processing'; restore already set status='Published' above, so here this
    // only fixes `ingestion` — a restored article whose cover/content image is Blocked (or still unscanned)
    // stays Blocked/Pending (hidden) instead of silently going live.
    const conn = await trx
      .selectFrom('ImageConnection as ic')
      .innerJoin('Image as i', 'i.id', 'ic.imageId')
      .select('i.ingestion')
      .where('ic.entityId', '=', id)
      .where('ic.entityType', '=', 'Article')
      .execute();
    const cover = article.coverId
      ? await trx
          .selectFrom('Image')
          .select('ingestion')
          .where('id', '=', article.coverId)
          .executeTakeFirst()
      : null;
    const states = [...conn.map((c) => c.ingestion), ...(cover ? [cover.ingestion] : [])];
    const total = states.length;
    const terminal = states.filter(
      (s) => s === 'Scanned' || s === 'Blocked' || s === 'Error' || s === 'NotFound'
    ).length;
    const imageBlocked = states.some((s) => s === 'Blocked');
    const imageError = states.some((s) => s === 'Error' || s === 'NotFound');
    const imageDone = total === 0 || terminal === total;

    const textMod = await trx
      .selectFrom('EntityModeration')
      .select(['status', 'blocked'])
      .where('entityType', '=', 'Article')
      .where('entityId', '=', id)
      .executeTakeFirst();
    const hasText =
      (article.title?.trim() ?? '').length > 0 ||
      (article.content ?? '').replace(/<[^>]*>/g, '').trim().length > 0;
    const textBlocked = hasText && textMod?.status === 'Succeeded' && textMod.blocked === true;
    const textError =
      hasText && !!textMod && ['Failed', 'Expired', 'Canceled'].includes(textMod.status);
    const textDone = !hasText || textMod?.status === 'Succeeded';

    const next =
      imageBlocked || textBlocked
        ? 'Blocked'
        : imageError || textError
        ? 'Error'
        : imageDone && textDone
        ? 'Scanned'
        : 'Pending';

    await trx
      .updateTable('Article')
      .set({
        ingestion: sql`${next}::"ArticleIngestionStatus"`,
        ...(next === 'Scanned' && article.ingestion !== 'Scanned'
          ? { contentScannedAt: new Date() }
          : {}),
      })
      .where('id', '=', id)
      .execute();

    return article.userId;
  });

  // The owner gained a published article — refresh their cached article count (createCachedObject: one key
  // per user at `${OVERVIEW_USERS}:articleCount:${userId}`).
  await bustCachedObject(`${REDIS_KEYS.CACHES.OVERVIEW_USERS}:articleCount`, userId);
}

async function deleteArticle(id: number): Promise<void> {
  await dbWrite.transaction().execute(async (trx) => {
    const article = await trx
      .selectFrom('Article')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!article) throw new Error(`No article with id ${id}`);

    await trx
      .deleteFrom('File')
      .where('entityId', '=', id)
      .where('entityType', '=', 'Article')
      .execute();
    await trx
      .deleteFrom('ImageConnection')
      .where('entityId', '=', id)
      .where('entityType', '=', 'Article')
      .execute();
    await trx.deleteFrom('Article').where('id', '=', id).execute();
  });

  // TODO(moderator-migration): the main app also deletes the cover + orphaned content images from DB + S3
  // + CDN cache (deleteImageById). S3 isn't wired in the spoke (Wave 5), so those image rows/objects are
  // left for that wave / a reconciliation job — the article row + its connections are fully removed here.
}
