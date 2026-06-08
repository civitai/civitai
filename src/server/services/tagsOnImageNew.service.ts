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
  const imageIds = args.filter((x) => moderatedTagIds.includes(x.tagId)).map((x) => x.imageId);

  await Limiter().process(imageIds, async (imageIds) => {
    await dbWrite.$executeRawUnsafe(`SELECT update_nsfw_levels_new(ARRAY[${imageIds.join(',')}])`);
    await thumbnailCache.refresh(imageIds);
  });
}

async function applyTagRules(args: TagsOnImageNewArgs[]) {
  const tagRules = await getTagRules();

  let applied = [...args];
  for (const rule of tagRules) {
    const nextTags: TagsOnImageNewArgs[] = [];
    for (const tag of applied) {
      if (tag.tagId === rule.toId) {
        if (rule.type === 'Replace') {
          nextTags.push({ ...tag, tagId: rule.fromId });
        } else {
          nextTags.push(tag);
          nextTags.push({ ...tag, tagId: rule.fromId, confidence: 70, source: 'Computed' });
        }
      } else {
        nextTags.push(tag);
      }
    }
    applied = nextTags;
  }

  return Object.values(
    applied.reduce<Record<string, TagsOnImageNewArgs>>((acc, tag) => {
      const key = `${tag.imageId}-${tag.tagId}`;
      if (!acc[key]) {
        acc[key] = tag;
      }
      return acc;
    }, {})
  );
}
