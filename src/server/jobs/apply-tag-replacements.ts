import { createJob, getJobDate } from './job';
import { getTagRules, TagRule } from '~/server/services/system-cache';
import { dbWrite } from '~/server/db/client';
import { Prisma } from '@prisma/client';

export const applyTagRules = createJob('apply-tag-rules', '*/5 * * * *', async () => {
  const [lastApplied, setLastApplied] = await getJobDate('apply-tag-rules');

  const tagRules = await getTagRules();
  for (const rule of tagRules) {
    const isNewRule = rule.createdAt > lastApplied;
    const since = isNewRule ? undefined : lastApplied;
    await appendTag(rule, since);
    if (rule.type === 'Replace') await deleteTag(rule, since);
  }

  await setLastApplied();
});

async function appendTag({ fromId, toId }: TagRule, since?: Date) {
  const sinceClause = since
    ? Prisma.raw(`AND "createdAt" > '${since.toISOString()}'`)
    : Prisma.empty;

  await dbWrite.$executeRaw`
    INSERT INTO "TagsOnModels"("modelId", "tagId")
    SELECT "modelId", ${fromId}
    FROM "TagsOnModels"
    WHERE "tagId" = ${toId} ${sinceClause}
    ON CONFLICT DO NOTHING;
  `;

  await dbWrite.$executeRaw`
    INSERT INTO "TagsOnArticle"("articleId", "tagId")
    SELECT "articleId", ${fromId}
    FROM "TagsOnArticle"
    WHERE "tagId" = ${toId} ${sinceClause}
    ON CONFLICT DO NOTHING;
  `;

  await dbWrite.$executeRaw`
    INSERT INTO "TagsOnPost"("postId", "tagId")
    SELECT "postId", ${fromId}
    FROM "TagsOnPost"
    WHERE "tagId" = ${toId} ${sinceClause}
    ON CONFLICT DO NOTHING;
  `;

  await dbWrite.$executeRaw`
    INSERT INTO "TagsOnCollection"("collectionId", "tagId")
    SELECT "collectionId", ${fromId}
    FROM "TagsOnCollection"
    WHERE "tagId" = ${toId} ${sinceClause}
    ON CONFLICT DO NOTHING;
  `;

  await dbWrite.$executeRaw`
    INSERT INTO "TagsOnImage"("imageId", "tagId", automated, confidence, "needsReview", source)
    SELECT "imageId", ${fromId}, automated, confidence, "needsReview", source
    FROM "TagsOnImage"
    WHERE "tagId" = ${toId} AND NOT disabled ${sinceClause}
    ON CONFLICT DO UPDATE SET confidence = excluded.confidence, source = excluded.source;
  `;
}

async function deleteTag({ toId }: TagRule, since?: Date) {
  const sinceClause = since
    ? Prisma.raw(`AND "createdAt" > '${since.toISOString()}'`)
    : Prisma.empty;

  await dbWrite.$executeRaw`
    DELETE FROM "TagsOnModels"
    WHERE "tagId" = ${toId} ${sinceClause};
  `;

  await dbWrite.$executeRaw`
    DELETE FROM "TagsOnArticle"
    WHERE "tagId" = ${toId} ${sinceClause};
  `;

  await dbWrite.$executeRaw`
    DELETE FROM "TagsOnPost"
    WHERE "tagId" = ${toId} ${sinceClause};
  `;

  await dbWrite.$executeRaw`
    DELETE FROM "TagsOnCollection"
    WHERE "tagId" = ${toId} ${sinceClause};
  `;

  await dbWrite.$executeRaw`
    UPDATE "TagsOnImage" SET disabled = true, "disabledAt" = now(), "disabledReason" = 'Replaced'
    WHERE "tagId" = ${toId} AND NOT disabled ${sinceClause};
  `;
}
