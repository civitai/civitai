import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS } from '@civitai/redis';
import { articleModerationFloorText } from '@civitai/shared/rated-entity-sql';
import { dbWrite } from './db';
import { bustCachedObject } from './cache';
import { getClickhouse } from './clickhouse';
import { deleteImageRows, finishImageDeletes } from './image-deletion';
import { syncSearchIndex } from './search-index';
import { logToAxiom } from './axiom';
import type { KeptImage } from '$lib/image-kept-reasons';
import {
  ArticleStatus,
  canRestoreArticle,
  restoreStatus,
  type ArticleMetadata,
} from '$lib/articles';
import type { ArticleUnpublishReason } from '$lib/article-unpublish-reasons';

type ModerateResult = { ok: true; kept?: KeptImage[] } | { ok: false; error: string };

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
  let kept: KeptImage[] | undefined;
  try {
    if (input.action === 'restore') await restoreArticle(input.articleId);
    else if (input.action === 'unpublish')
      await unpublishArticle(input.articleId, input.userId, input.reason, input.customMessage);
    else kept = await deleteArticle(input.articleId);
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

  return kept?.length ? { ok: true, kept } : { ok: true };
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
      // Only a Published article gets here: a restore must publish it again, whatever an earlier
      // block recorded.
      statusBeforeViolation: undefined,
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

type RestoredIngestion = 'Scanned' | 'Blocked' | 'Error' | 'Pending';

/**
 * `derived` as the main app's ingestion recompute adjusts it for content urls it holds without an
 * image row: refused counts as blocked, deferred as unscanned, and neither is covered by a
 * moderator's rating.
 */
export function withContentLinkHold(
  derived: RestoredIngestion,
  hold: { deferred: string[]; refused: string[] } | undefined
): RestoredIngestion {
  if (hold?.refused.length) return 'Blocked';
  if (hold?.deferred.length && derived === 'Scanned') return 'Pending';
  return derived;
}

// The main app's share-link lock (`lockAccessTokens` in access-token.service.ts), taken before the
// row lock as it is there, so a link being created waits for this transaction.
const ACCESS_TOKEN_LOCK_CLASS = 0x41544b;

async function restoreArticle(id: number): Promise<void> {
  const userId = await dbWrite.transaction().execute(async (trx): Promise<number> => {
    // A share link made while it was unpublished must not read it again after a later unpublish.
    await sql`SELECT pg_advisory_xact_lock(${ACCESS_TOKEN_LOCK_CLASS}::int, ${id}::int)`.execute(
      trx
    );
    await trx
      .updateTable('AccessToken')
      .set({ revokedAt: new Date() })
      .where('resourceType', '=', 'Article')
      .where('resourceId', '=', id)
      .where('revokedAt', 'is', null)
      .execute();
    const article = await trx
      .selectFrom('Article')
      .select([
        'status',
        'publishedAt',
        'metadata',
        'userId',
        'coverId',
        'bannerId',
        'title',
        'content',
        'ingestion',
        'moderatorNsfwLevel',
      ])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!article) throw new Error(`No article with id ${id}`);
    if (!UNPUBLISHED.includes(article.status as ArticleStatus))
      throw new Error('Article is not unpublished');
    if (!canRestoreArticle({ ...article, metadata: article.metadata as ArticleMetadata }))
      throw new Error('The author unpublished this article; only they can republish it.');

    const meta = { ...((article.metadata as ArticleMetadata) ?? {}) } as Record<string, unknown>;
    delete meta.unpublishedReason;
    delete meta.customMessage;
    delete meta.unpublishedAt;
    delete meta.unpublishedBy;
    delete meta.statusBeforeViolation;
    const status = restoreStatus(article.metadata as ArticleMetadata, article.publishedAt);

    await trx
      .updateTable('Article')
      .set({
        status,
        // Preserve the original publishedAt so a restored article doesn't bump to the top of the feed.
        publishedAt:
          status === ArticleStatus.Published
            ? article.publishedAt ?? new Date()
            : article.publishedAt,
        metadata: sql`${JSON.stringify(meta)}::jsonb`,
        // The author schedules it again: one that lapsed while it was blocked would go live at once.
        ...(status === ArticleStatus.Draft ? { scheduledAt: null } : {}),
      })
      .where('id', '=', id)
      .execute();

    // Re-derive nsfwLevel so a cover raised to X/Blocked while unpublished can't leak into an SFW feed on
    // republish; a moderator override still wins (the COALESCE).
    await sql`
      WITH level AS (
        SELECT a.id, GREATEST(
          COALESCE(max(cover."nsfwLevel"), 0),
          COALESCE(max(banner."nsfwLevel"), 0),
          COALESCE(max(content_imgs."nsfwLevel"), 0)
        ) AS "nsfwLevel"
        FROM "Article" a
        LEFT JOIN "Image" cover
          ON a."coverId" = cover.id AND cover."ingestion" IN ('Scanned', 'Blocked')
        LEFT JOIN "Image" banner
          ON a."bannerId" = banner.id AND banner."ingestion" IN ('Scanned', 'Blocked')
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
    const ownImageIds = [article.coverId, article.bannerId].filter((x): x is number => x != null);
    const own = ownImageIds.length
      ? await trx.selectFrom('Image').select('ingestion').where('id', 'in', ownImageIds).execute()
      : [];
    const states = [...conn.map((c) => c.ingestion), ...own.map((o) => o.ingestion)];
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
    const hold = await trx
      .selectFrom('ArticleContentLinkHold')
      .select(['deferred', 'refused'])
      .where('articleId', '=', id)
      .executeTakeFirst();
    const derived: RestoredIngestion = hasModeratorOverride
      ? 'Scanned'
      : imageBlocked || textBlocked
      ? 'Blocked'
      : imageError || textError
      ? 'Error'
      : imageDone && textDone
      ? 'Scanned'
      : 'Pending';
    const next = withContentLinkHold(derived, hold);

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

/** Deletes the article and its orphaned images; returns the images a hold kept. */
async function deleteArticle(id: number): Promise<KeptImage[]> {
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
  const rows = await dbWrite.transaction().execute(async (trx) => {
    const article = await trx
      .selectFrom('Article')
      .select(['coverId', 'bannerId'])
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
    const ownImageIds = [
      ...new Set([article.coverId, article.bannerId].filter((x): x is number => x != null)),
    ];
    // A cover or banner set by id can also be another article's cover or banner.
    const stillShown = ownImageIds.length
      ? await trx
          .selectFrom('Article')
          .select(['coverId', 'bannerId'])
          .where((eb) =>
            eb.or([eb('coverId', 'in', ownImageIds), eb('bannerId', 'in', ownImageIds)])
          )
          .execute()
      : [];
    const shownIds = new Set(stillShown.flatMap((a) => [a.coverId, a.bannerId]));
    const toDelete = ownImageIds.filter((imageId) => !shownIds.has(imageId));

    const orphanCandidates = contentImageIds.filter((imageId) => !ownImageIds.includes(imageId));
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

    return toDelete.length ? deleteImageRows(trx, toDelete) : null;
  });

  if (!rows) return [];
  if (rows.refused.length)
    void logToAxiom({
      type: 'info',
      name: 'image-deletion',
      message: 'images kept by a hold',
      articleId: id,
      kept: rows.refused,
    }).catch(() => undefined);
  await finishImageDeletes(rows);
  return rows.refused;
}
