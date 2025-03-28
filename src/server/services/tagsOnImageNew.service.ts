import { dbWrite } from '~/server/db/client';
import { tagIdsForImagesCache, thumbnailCache } from '~/server/redis/caches';
import { TagSource } from '~/shared/utils/prisma/enums';
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
      WHERE ("tagId", "imageId") IN (SELECT * FROM (VALUES ${values}) AS t("imageId", "tagId"));
    `);

    const imageIds = [...new Set(items.map((x) => x.imageId))];
    await tagIdsForImagesCache.bust(imageIds);
  });

  await updateImageNsfwLevels(args);
  await queueImageSearchIndexUpdate({
    ids: args.map((x) => x.imageId),
    action: SearchIndexUpdateQueueAction.Delete,
  });
}

async function updateImageNsfwLevels(args: { imageId: number; tagId: number }[]) {
  const moderatedTagIds = await getModeratedTags().then((data) => data.map((x) => x.id));
  const imageIds = args.filter((x) => moderatedTagIds.includes(x.tagId)).map((x) => x.imageId);

  await Limiter().process(imageIds, async (imageIds) => {
    await dbWrite.$executeRawUnsafe(`SELECT update_nsfw_levels_new(ARRAY[${imageIds.join(',')}])`);
    await thumbnailCache.bust(imageIds);
  });
}

async function applyTagRules(args: TagsOnImageNewArgs[]) {
  const tagRules = await getTagRules();
  return tagRules.reduce<TagsOnImageNewArgs[]>(
    (tags, rule) => {
      const index = tags.findIndex((x) => x.tagId === rule.toId);
      if (index === -1) return tags;

      const existing = tags[index];
      if (rule.type === 'Replace') {
        if (existing) tags[index] = { ...existing, tagId: rule.fromId };
        return tags;
      }

      return [...tags, { ...existing, tagId: rule.fromId, confidence: 70, source: 'Computed' }];
    },
    [...args]
  );
}
