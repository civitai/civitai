import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS } from '@civitai/redis';
import { articleModerationFloorText } from '@civitai/shared/rated-entity-sql';
import { dbWrite } from './db';
import { bustCachedObject } from './cache';
import { getClickhouse } from './clickhouse';
import { deleteImageRows, finishImageDeletes } from './image-deletion';
import { profilePictureUserIds } from './profile-picture-cache';
import { syncSearchIndex } from './search-index';
import { ArticleStatus, type ArticleMetadata } from '$lib/articles';
import type { ArticleUnpublishReason } from '$lib/article-unpublish-reasons';

type ModerateResult = { ok: true } | { ok: false; error: string };

const UNPUBLISHED: ArticleStatus[] = [
  ArticleStatus.Unpublished,
  ArticleStatus.UnpublishedViolation,
];

export async function moderateArticle(
  input:
    | { action: 'restore' | 'delete'; articleId: number; userId: number }
    | {
        action: 'unpublish';
        articleId: number;
        userId: number;
        reason: ArticleUnpublishReason;
        /** Shown to the author for `other`; an internal note for every other reason, as on the site. */
        customMessage: string | null;
      }
): Promise<ModerateResult> {
  try {
    if (input.action === 'restore') await restoreArticle(input.articleId);
    else if (input.action === 'unpublish')
      await unpublishArticle(input.articleId, input.userId, input.reason, input.customMessage);
    else await deleteArticle(input.articleId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // An unpublished article leaves search, as the main app's `unpublishArticleById` takes it out.
  void syncSearchIndex({
    entityType: 'article',
    entityId: input.articleId,
    action: input.action === 'restore' ? 'update' : 'delete',
  });

  if (input.action === 'delete') void recordArticleEvent('Delete', input.articleId, input.userId);
  if (input.action === 'unpublish')
    void recordArticleEvent('Unpublish', input.articleId, input.userId);

  return { ok: true };
}

async function recordArticleEvent(
  type: 'Delete' | 'Unpublish',
  articleId: number,
  moderatorId: number
): Promise<void> {
  try {
    await getClickhouse().insert({
      table: 'articles',
      values: [{ userId: moderatorId, type, articleId, nsfw: false }],
      format: 'JSONEachRow',
    });
  } catch (err) {
    console.error(`[article-moderation] failed to record ${type.toLowerCase()} event`, err);
  }
}

/**
 * The author's three article counts — every article, the SFW-only one and the public one
 * (`src/server/redis/caches.ts`) — all count Published rows only, so a status change in either
 * direction leaves them wrong for a day (their TTL) unless busted.
 */
const ARTICLE_COUNT_CACHES = ['articleCount', 'articleCount:sfw', 'articleCount:public'] as const;
async function bustArticleCounts(userId: number): Promise<void> {
  for (const name of ARTICLE_COUNT_CACHES)
    await bustCachedObject(`${REDIS_KEYS.CACHES.OVERVIEW_USERS}:${name}`, userId);
}

/**
 * The main app's `unpublishArticleById` as a moderator runs it: always as a violation, with the reason
 * the author's banner is drawn from. Only a Published article — the site refuses anything else, and
 * unpublishing a draft would stamp a violation on something that was never live.
 */
async function unpublishArticle(
  id: number,
  moderatorId: number,
  reason: ArticleUnpublishReason,
  customMessage: string | null
): Promise<void> {
  const userId = await dbWrite.transaction().execute(async (trx): Promise<number> => {
    const article = await trx
      .selectFrom('Article')
      .select(['status', 'publishedAt', 'metadata', 'userId'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!article) throw new Error(`No article with id ${id}`);
    if (!article.publishedAt || article.status !== ArticleStatus.Published)
      throw new Error('Article is not published');

    const meta = {
      ...((article.metadata as ArticleMetadata) ?? {}),
      unpublishedReason: reason,
      customMessage,
      unpublishedAt: new Date().toISOString(),
      unpublishedBy: moderatorId,
    };
    await trx
      .updateTable('Article')
      .set({
        status: ArticleStatus.UnpublishedViolation,
        metadata: sql`${JSON.stringify(meta)}::jsonb`,
      })
      .where('id', '=', id)
      .execute();
    return article.userId;
  });

  await bustArticleCounts(userId);
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
        'moderatorNsfwLevel',
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

    // Re-derive nsfwLevel so a cover raised to X/Blocked while unpublished can't leak into an SFW feed on
    // republish; a moderator override still wins (the COALESCE).
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
        SELECT a.id, ${sql.raw(articleModerationFloorText('a.id'))} AS "floor"
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

    // Re-derive ingestion from image scan states + text moderation so a restored article whose cover/content
    // image is Blocked or still unscanned stays hidden instead of silently going live.
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

    // A moderator override must keep the article Scanned even if an image is still non-terminal, else a
    // restored mod-pinned article is wrongly hidden.
    const hasModeratorOverride = article.moderatorNsfwLevel != null;
    const next = hasModeratorOverride
      ? 'Scanned'
      : imageBlocked || textBlocked
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

  await bustArticleCounts(userId);
}

async function deleteArticle(id: number): Promise<void> {
  // Capture the content image ids before the transaction deletes the connections, or they're lost.
  const contentImageIds = (
    await dbWrite
      .selectFrom('ImageConnection')
      .select('imageId')
      .where('entityId', '=', id)
      .where('entityType', '=', 'Article')
      .execute()
  ).map((c) => c.imageId);

  // The orphaned images go in the same transaction, so a delete that cannot finish leaves the
  // article and its images as they were, and can be retried.
  const { rows, avatarUserIds } = await dbWrite.transaction().execute(async (trx) => {
    const article = await trx
      .selectFrom('Article')
      .select('coverId')
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

    // "Orphaned" means no remaining ImageConnection; a post membership (postId) does NOT keep an image alive.
    const toDelete: number[] = [];
    if (article.coverId) toDelete.push(article.coverId);

    const orphanCandidates = contentImageIds.filter((imageId) => imageId !== article.coverId);
    if (orphanCandidates.length) {
      const orphaned = await trx
        .selectFrom('Image')
        .select('Image.id')
        .where('Image.id', 'in', orphanCandidates)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('ImageConnection')
                .select('ImageConnection.imageId')
                .whereRef('ImageConnection.imageId', '=', 'Image.id')
            )
          )
        )
        .execute();
      toDelete.push(...orphaned.map((o) => o.id));
    }

    if (!toDelete.length) return { rows: null, avatarUserIds: [] };
    const avatarUserIds = await profilePictureUserIds(toDelete).catch(() => []);
    return { rows: await deleteImageRows(trx, toDelete), avatarUserIds };
  });

  if (rows) await finishImageDeletes(rows, avatarUserIds);
}
