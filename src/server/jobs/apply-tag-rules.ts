import { createJob, getJobDate } from './job';
import { getTagRules, TagRule } from '~/server/services/system-cache';
import { dbWrite } from '~/server/db/client';
import { Prisma } from '@prisma/client';
import { createLogger } from '~/utils/logging';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const log = createLogger('jobs:apply-tag-rules', 'cyan');
const IMAGE_BATCH_SIZE = 100000;

export const applyTagRules = createJob('apply-tag-rules', '*/5 * * * *', async () => {
  const [lastApplied, setLastApplied] = await getJobDate('apply-tag-rules');
  log(lastApplied);

  const tagRules = await getTagRules();

  // Get image limit
  const images = await dbWrite.$queryRaw<[{ id: number }]>`
    SELECT MAX(id) as id FROM "Image"
  `;
  const maxImageId = images[0].id;

  for (const rule of tagRules) {
    const isNewRule = rule.createdAt > lastApplied;
    const since = isNewRule ? undefined : lastApplied;

    log(`Applying ${rule.type}: ${rule.toTag} -> ${rule.fromTag}`);
    await appendTag(rule, maxImageId, since);
    if (rule.type === 'Replace') await deleteTag(rule, maxImageId, since);
  }

  await setLastApplied();
});

async function appendTag({ fromId, toId }: TagRule, maxImageId: number, since?: Date) {
  const sinceClause = since
    ? Prisma.raw(`AND "createdAt" > '${since.toISOString()}'`)
    : Prisma.empty;

  log('Updating models');
  await dbWrite.$executeRaw`
    INSERT INTO "TagsOnModels"("modelId", "tagId")
    SELECT "modelId", ${fromId}
    FROM "TagsOnModels"
    WHERE "tagId" = ${toId} ${sinceClause}
    ON CONFLICT ("modelId", "tagId") DO NOTHING;
  `;

  log('Updating articles');
  await dbWrite.$executeRaw`
    INSERT INTO "TagsOnArticle"("articleId", "tagId")
    SELECT "articleId", ${fromId}
    FROM "TagsOnArticle"
    WHERE "tagId" = ${toId} ${sinceClause}
    ON CONFLICT ("articleId", "tagId") DO NOTHING;
  `;

  log('Updating posts');
  await dbWrite.$executeRaw`
    INSERT INTO "TagsOnPost"("postId", "tagId")
    SELECT "postId", ${fromId}
    FROM "TagsOnPost"
    WHERE "tagId" = ${toId} ${sinceClause}
    ON CONFLICT ("postId", "tagId") DO NOTHING;
  `;

  log('Updating collections');
  await dbWrite.$executeRaw`
    INSERT INTO "TagsOnCollection"("collectionId", "tagId")
    SELECT "collectionId", ${fromId}
    FROM "TagsOnCollection"
    WHERE "tagId" = ${toId} ${sinceClause}
    ON CONFLICT ("collectionId", "tagId") DO NOTHING;
  `;

  log('Updating images');
  // Break into batches so that we can handle large numbers of images
  let cursor = 0;
  const batchSize = since ? 100 * IMAGE_BATCH_SIZE : IMAGE_BATCH_SIZE;
  await limitConcurrency(() => {
    if (cursor > maxImageId) return null; // We've reached the end of the images

    const start = cursor;
    cursor += batchSize;
    const end = cursor;
    log(`Updating images ${start} - ${end}`);
    return async () => {
      await dbWrite.$queryRaw`
        SELECT (upsert_tag_on_image("imageId", ${fromId}, "source",  "confidence", "automated", null, "needsReview")).*
        FROM "TagsOnImageDetails" toi
        WHERE "tagId" = ${toId}
          AND "disabled" IS FALSE
          AND "imageId" >= ${start}
          AND "imageId" < ${end}
          AND EXISTS (SELECT 1 FROM "Image" WHERE id = toi."imageId") -- Ensure image exists
          ${sinceClause};
      `;
    };
  }, 3);
}

async function deleteTag({ toId }: TagRule, maxImageId: number, since?: Date) {
  const sinceClause = since
    ? Prisma.raw(`AND "createdAt" > '${since.toISOString()}'`)
    : Prisma.empty;

  log('Deleting models');
  await dbWrite.$executeRaw`
    DELETE FROM "TagsOnModels"
    WHERE "tagId" = ${toId} ${sinceClause};
  `;

  log('Deleting articles');
  await dbWrite.$executeRaw`
    DELETE FROM "TagsOnArticle"
    WHERE "tagId" = ${toId} ${sinceClause};
  `;

  log('Deleting posts');
  await dbWrite.$executeRaw`
    DELETE FROM "TagsOnPost"
    WHERE "tagId" = ${toId} ${sinceClause};
  `;

  log('Deleting collections');
  await dbWrite.$executeRaw`
    DELETE FROM "TagsOnCollection"
    WHERE "tagId" = ${toId} ${sinceClause};
  `;

  log('Disabling images');
  // Break into batches so that we can handle large numbers of images
  let cursor = 0;
  const batchSize = since ? 100 * IMAGE_BATCH_SIZE : IMAGE_BATCH_SIZE;
  await limitConcurrency(() => {
    if (cursor > maxImageId) return null; // We've reached the end of the images

    const start = cursor;
    cursor += batchSize;
    const end = cursor;
    log(`Updating images ${start} - ${end}`);
    return async () => {
      await dbWrite.$queryRaw`
        SELECT (upsert_tag_on_image("imageId", "tagId", null, null, null, true, null)).*
        FROM "TagsOnImageDetails"
        WHERE "tagId" = ${toId} AND "disabled" IS FALSE
          AND "imageId" >= ${start}
          AND "imageId" < ${end}
          ${sinceClause};
      `;
    };
  }, 3);
}
