import { dbWrite } from '~/server/db/client';
import { tagIdsForImagesCache, refreshThumbnailCache, imageTagsCache } from '~/server/redis/caches';
import type { TagSource } from '~/shared/utils/prisma/enums';
import { pgDbWrite } from '~/server/db/pgDb';
import { Limiter } from '~/server/utils/concurrency-helpers';
import { getModeratedTags, getTagRules } from '~/server/services/system-cache';
import { createImageTagsForReview } from '~/server/services/image-review.service';
import { NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';

// Lazy: a static import here closes the image.service import cycle (no-image-service-import-cycle).
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

export async function insertTagsOnImageNew(args: TagsOnImageNewArgs[]) {
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
      SELECT insert_tag_on_image(t."imageId", t."tagId", t."source"::"TagSource", t."confidence"::integer, t."automated"::boolean, t."disabled"::boolean, t."needsReview"::boolean)
      FROM (VALUES ${values}) AS t("imageId", "tagId", "source", "confidence", "automated", "disabled", "needsReview");
    `);

    const imageIds = [...new Set(items.map((x) => x.imageId))];
    await tagIdsForImagesCache.bust(imageIds);
    await imageTagsCache.bust(imageIds);
  });

  await updateImageNsfwLevels(withTagRules);
  await (
    await imageService()
  ).queueImageSearchIndexUpdate({
    ids: args.map((x) => x.imageId),
    action: SearchIndexUpdateQueueAction.Update,
  });
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

  await updateImageNsfwLevels(withTagRules);
  await (
    await imageService()
  ).queueImageSearchIndexUpdate({
    ids: args.map((x) => x.imageId),
    action: SearchIndexUpdateQueueAction.Update,
  });
}

export async function deleteTagsOnImageNew(args: { imageId: number; tagId: number }[]) {
  await Limiter().process(args, async (items) => {
    const values = items.map((item) => `(${item.imageId}, ${item.tagId})`).join(', ');

    await pgDbWrite.query(`
      DELETE FROM "TagsOnImageNew"
      WHERE ("imageId", "tagId") IN (SELECT * FROM (VALUES ${values}) AS t("imageId", "tagId"));
    `);

    const imageIds = [...new Set(items.map((x) => x.imageId))];
    await tagIdsForImagesCache.bust(imageIds);
    await imageTagsCache.bust(imageIds);
  });

  await updateImageNsfwLevels(args);
  await (
    await imageService()
  ).queueImageSearchIndexUpdate({
    ids: args.map((x) => x.imageId),
    action: SearchIndexUpdateQueueAction.Update,
  });
}

async function updateImageNsfwLevels(args: { imageId: number; tagId: number }[]) {
  const moderatedTags = await getModeratedTags();
  const moderatedTagIds = moderatedTags.map((x) => x.id);
  const imageIds = [
    ...new Set(args.filter((x) => moderatedTagIds.includes(x.tagId)).map((x) => x.imageId)),
  ];

  if (!imageIds.length) return;

  await Limiter().process(imageIds, async (imageIds) => {
    await dbWrite.$executeRawUnsafe(`SELECT update_nsfw_levels_new(ARRAY[${imageIds.join(',')}])`);
    await refreshThumbnailCache(imageIds);
  });

  const blockedTagIds = new Set(
    moderatedTags.filter((x) => x.nsfwLevel === NsfwLevel.Blocked).map((x) => x.id)
  );
  await queueBlockedTagReviews(args.filter((x) => blockedTagIds.has(x.tagId)));
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
