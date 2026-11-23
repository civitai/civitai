import type { PoolClient } from 'pg';
import { dbWrite } from '~/server/db/client';
import { evictHomeBlocksForImages } from '~/server/services/home-block-cache.service';
import { tagIdsForImagesCache, refreshThumbnailCache, imageTagsCache } from '~/server/redis/caches';
import type { TagSource } from '~/shared/utils/prisma/enums';
import { pgDbWrite } from '~/server/db/pgDb';
import { Limiter } from '~/server/utils/concurrency-helpers';
import { getModeratedTags, getTagRules } from '~/server/services/system-cache';
import { createImageTagsForReview } from '~/server/services/image-review.service';
import { NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { refreshProfilePicturesForImagesLazy } from '~/server/services/refresh-profile-pictures-lazy';
import { queueDocumentsForImageMinorChanges } from '~/server/services/image-models-reindex.service';

// Lazy, but not a cycle cut: the cycle guards count dynamic imports (docs/dev/import-cycles.md).
const imageService = () => import('~/server/services/image.service');

type TagsOnImageNewArgs = {
  imageId: number;
  tagId: number;
  source?: TagSource;
  confidence?: number;
  automated?: boolean;
  disabled?: boolean;
  needsReview?: boolean;
};

/**
 * A caller's open transaction for `insertTagsOnImageNew` / `deleteTagsOnImageNew`: the rows are
 * written on `client`, and the work that must follow the commit (cache busts, the rating recount,
 * the search queue) is pushed onto `afterCommit` for the caller to run once it has committed.
 */
export type TagWriteTransaction = {
  client: Pick<PoolClient, 'query'>;
  afterCommit: (() => Promise<void>)[];
};

/** Busts the caches of the images whose tags were written. */
async function bustImageTagCaches(items: { imageId: number }[]) {
  const imageIds = [...new Set(items.map((x) => x.imageId))];
  await tagIdsForImagesCache.bust(imageIds);
  await imageTagsCache.bust(imageIds);
}

/** The work that follows a tag write: the caches (in a transaction), ratings and search queue. */
async function afterTagWrite(
  written: { imageId: number; tagId: number }[],
  imageIds: number[],
  tx: TagWriteTransaction | undefined
) {
  const run = async () => {
    if (tx) await bustImageTagCaches(written);
    const levelImageIds = await updateImageNsfwLevels(written);
    await queueDocumentsForImageMinorChanges({ levelImageIds });
    await (
      await imageService()
    ).queueImageSearchIndexUpdate({ ids: imageIds, action: SearchIndexUpdateQueueAction.Update });
  };
  if (tx) tx.afterCommit.push(run);
  else await run();
}

export async function insertTagsOnImageNew(args: TagsOnImageNewArgs[], tx?: TagWriteTransaction) {
  if (!args.length) return;

  const withTagRules = await applyTagRules(args);

  await Limiter().process(withTagRules, async (items) => {
    const values = items
      .map((item) => {
        const source = item.source ? `'${item.source}'::"TagSource"` : null;
        const confidence = item.confidence ?? null;
        const automated = item.automated ?? null;
        const disabled = item.disabled ?? null;
        const needsReview = item.needsReview ?? null;
        return `(${item.imageId}, ${item.tagId}, ${source}, ${confidence}, ${automated}, ${disabled}, ${needsReview})`;
      })
      .join(', ');

    await (tx?.client ?? pgDbWrite).query(`
      SELECT insert_tag_on_image(t."imageId", t."tagId", t."source"::"TagSource", t."confidence"::integer, t."automated"::boolean, t."disabled"::boolean, t."needsReview"::boolean)
      FROM (VALUES ${values}) AS t("imageId", "tagId", "source", "confidence", "automated", "disabled", "needsReview");
    `);

    // Before the commit, a bust lets a reader cache the old tags again; a transaction busts after.
    if (!tx) await bustImageTagCaches(items);
  });

  await afterTagWrite(
    withTagRules,
    args.map((x) => x.imageId),
    tx
  );
}

export async function upsertTagsOnImageNew(args: TagsOnImageNewArgs[]) {
  if (!args.length) return;

  const withTagRules = await applyTagRules(args);

  await Limiter().process(withTagRules, async (items) => {
    const values = items
      .map((item) => {
        const source = item.source ? `'${item.source}'::"TagSource"` : null;
        const confidence = item.confidence ?? null;
        const automated = item.automated ?? null;
        const disabled = item.disabled ?? null;
        const needsReview = item.needsReview ?? null;
        return `(${item.imageId}, ${item.tagId}, ${source}, ${confidence}, ${automated}, ${disabled}, ${needsReview})`;
      })
      .join(', ');

    await pgDbWrite.query(`
          SELECT upsert_tag_on_image(t."imageId", t."tagId", t."source"::"TagSource", t."confidence"::integer, t."automated"::boolean, t."disabled"::boolean, t."needsReview"::boolean)
          FROM (VALUES ${values}) AS t("imageId", "tagId", "source", "confidence", "automated", "disabled", "needsReview");
        `);

    const imageIds = [...new Set(items.map((x) => x.imageId))];
    await tagIdsForImagesCache.bust(imageIds);
    await imageTagsCache.bust(imageIds);
  });

  const levelImageIds = await updateImageNsfwLevels(withTagRules);
  await queueDocumentsForImageMinorChanges({ levelImageIds });
  await (
    await imageService()
  ).queueImageSearchIndexUpdate({
    ids: args.map((x) => x.imageId),
    action: SearchIndexUpdateQueueAction.Update,
  });
}

export async function deleteTagsOnImageNew(
  args: { imageId: number; tagId: number }[],
  tx?: TagWriteTransaction
) {
  await Limiter().process(args, async (items) => {
    const values = items.map((item) => `(${item.imageId}, ${item.tagId})`).join(', ');

    await (tx?.client ?? pgDbWrite).query(`
      DELETE FROM "TagsOnImageNew"
      WHERE ("imageId", "tagId") IN (SELECT * FROM (VALUES ${values}) AS t("imageId", "tagId"));
    `);

    if (!tx) await bustImageTagCaches(items);
  });

  await afterTagWrite(
    args,
    args.map((x) => x.imageId),
    tx
  );
}

async function updateImageNsfwLevels(args: { imageId: number; tagId: number }[]) {
  const moderatedTags = await getModeratedTags();
  const moderatedTagIds = moderatedTags.map((x) => x.id);
  const imageIds = [
    ...new Set(args.filter((x) => moderatedTagIds.includes(x.tagId)).map((x) => x.imageId)),
  ];

  if (!imageIds.length) return imageIds;

  await Limiter().process(imageIds, async (imageIds) => {
    await dbWrite.$executeRawUnsafe(`SELECT update_nsfw_levels_new(ARRAY[${imageIds.join(',')}])`);
    // An avatar is gated on its cached rating, so one re-rated here must be re-read too.
    await Promise.all([
      refreshThumbnailCache(imageIds),
      refreshProfilePicturesForImagesLazy(imageIds),
    ]);
  });

  const blockedTagIds = new Set(
    moderatedTags.filter((x) => x.nsfwLevel === NsfwLevel.Blocked).map((x) => x.id)
  );
  await queueBlockedTagReviews(args.filter((x) => blockedTagIds.has(x.tagId)));
  return imageIds;
}

// update_nsfw_levels_new raises an image to Blocked but never queues it, so a blocked-level tag
// that arrives after the scan (votes, tag rules, mod tools) would leave it hidden with no review.
async function queueBlockedTagReviews(args: { imageId: number; tagId: number }[]) {
  if (!args.length) return;

  const queued = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
    WITH written AS (
      SELECT DISTINCT (value ->> 'imageId')::int "imageId", (value ->> 'tagId')::int "tagId"
      FROM json_array_elements(${JSON.stringify(args)}::json)
    ), enabled AS (
      SELECT w."imageId", w."tagId"
      FROM written w
      JOIN "TagsOnImageDetails" toi
        ON toi."imageId" = w."imageId" AND toi."tagId" = w."tagId" AND NOT toi.disabled
    ), flagged AS (
      UPDATE "Image" i SET "needsReview" = 'tag'
      WHERE i.id IN (SELECT "imageId" FROM enabled)
        AND i."nsfwLevel" = ${NsfwLevel.Blocked}
        AND i."needsReview" IS NULL
        AND i.ingestion = 'Scanned'
        AND i."blockedFor" IS NULL
        AND NOT i."nsfwLevelLocked"
      RETURNING i.id
    )
    SELECT e."imageId", e."tagId"
    FROM enabled e
    JOIN flagged f ON f.id = e."imageId"
  `;

  if (queued.length)
    await evictHomeBlocksForImages({ imageIds: [...new Set(queued.map((x) => x.imageId))] });

  const tagIdsByImage = new Map<number, number[]>();
  for (const { imageId, tagId } of queued) {
    tagIdsByImage.set(imageId, [...(tagIdsByImage.get(imageId) ?? []), tagId]);
  }
  for (const [imageId, tagIds] of tagIdsByImage) {
    await createImageTagsForReview({ imageId, tagIds });
  }
}

export async function applyTagRules(args: TagsOnImageNewArgs[]) {
  const tagRules = await getTagRules();

  const keyOf = (imageId: number, tagId: number) => `${imageId}|${tagId}`;

  // First-wins: a tag already present is never replaced, so a genuine User/
  // high-confidence tag is not downgraded when a rule would append it as Computed.
  const appliedMap: Record<string, TagsOnImageNewArgs> = {};
  for (const tag of args) {
    const key = keyOf(tag.imageId, tag.tagId);
    if (!appliedMap[key]) appliedMap[key] = tag;
  }

  for (const rule of tagRules) {
    const toAdd: Record<string, TagsOnImageNewArgs> = {};
    const toRemove: string[] = [];

    for (const key in appliedMap) {
      const tag = appliedMap[key];
      if (tag.tagId === rule.toId) {
        const targetKey = keyOf(tag.imageId, rule.fromId);
        if (rule.type === 'Replace') {
          toRemove.push(key);
          if (!toAdd[targetKey]) toAdd[targetKey] = { ...tag, tagId: rule.fromId };
        } else if (!toAdd[targetKey]) {
          toAdd[targetKey] = { ...tag, tagId: rule.fromId, confidence: 70, source: 'Computed' };
        }
      }
    }

    for (const key of toRemove) delete appliedMap[key];
    for (const key in toAdd) if (!appliedMap[key]) appliedMap[key] = toAdd[key];
  }

  return Object.values(appliedMap);
}
