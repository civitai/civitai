import { dbWrite } from '~/server/db/client';
import { tagIdsForImagesCache, thumbnailCache, imageTagsCache } from '~/server/redis/caches';
import type { TagSource } from '~/shared/utils/prisma/enums';
import { pgDbWrite } from '~/server/db/pgDb';
import { Limiter } from '~/server/utils/concurrency-helpers';
import { getModeratedTags, getTagRules } from '~/server/services/system-cache';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

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

  await updateImageNsfwLevels(args);
  await queueImageSearchIndexUpdate({
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

  await updateImageNsfwLevels(args);
  await queueImageSearchIndexUpdate({
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
  await queueImageSearchIndexUpdate({
    ids: args.map((x) => x.imageId),
    action: SearchIndexUpdateQueueAction.Update,
  });
}

async function updateImageNsfwLevels(args: { imageId: number; tagId: number }[]) {
  const moderatedTagIds = await getModeratedTags().then((data) => data.map((x) => x.id));
  const imageIds = [...new Set(args.filter((x) => moderatedTagIds.includes(x.tagId)).map((x) => x.imageId))];

  if (!imageIds.length) return;

  await Limiter().process(imageIds, async (imageIds) => {
    await dbWrite.$executeRawUnsafe(`SELECT update_nsfw_levels_new(ARRAY[${imageIds.join(',')}])`);
    await thumbnailCache.refresh(imageIds);
  });
}

export async function applyTagRules(args: TagsOnImageNewArgs[]) {
  const tagRules = await getTagRules();

  const getMap = (items: TagsOnImageNewArgs[]) =>
    items.reduce<Record<string, TagsOnImageNewArgs>>((acc, tag) => {
      acc[`${tag.imageId}|${tag.tagId}`] = tag;
      return acc;
    }, {});

  const appliedMap = getMap(args);

  for (const rule of tagRules) {
    const toAdd: Record<string, TagsOnImageNewArgs> = {};
    const toRemove: string[] = [];

    for (const key in appliedMap) {
      const tag = appliedMap[key];
      if (tag.tagId === rule.toId) {
        if (rule.type === 'Replace') {
          toRemove.push(key);
          toAdd[`${tag.imageId}|${rule.fromId}`] = { ...tag, tagId: rule.fromId };
        } else {
          toAdd[`${tag.imageId}|${rule.fromId}`] = { ...tag, tagId: rule.fromId, confidence: 70, source: 'Computed' };
        }
      }
    }

    for (const key of toRemove) delete appliedMap[key];
    for (const key in toAdd) appliedMap[key] = toAdd[key];
  }

  return Object.values(appliedMap);
}
