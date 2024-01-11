import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

export const resetToDraftWithoutRequirements = createJob(
  'reset-to-draft-without-requirements',
  '43 2 * * *',
  async () => {
    // Get all published model versions that have no posts
    const modelVersionsWithoutPosts = await dbWrite.$queryRaw<{ modelVersionId: number }[]>`
      SELECT
        mv.id "modelVersionId"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE
        mv.status = 'Published'
        AND m.status = 'Published'
        AND m."userId" != -1
        AND NOT EXISTS (SELECT 1 FROM "Post" p WHERE p."modelVersionId" = mv.id AND p."userId" = m."userId")
        AND m."deletedAt" IS NULL;
    `;

    if (modelVersionsWithoutPosts.length) {
      // Unpublish all model versions that have no posts and flag them for notification
      const modelVersionIds = modelVersionsWithoutPosts.map((r) => r.modelVersionId);
      await dbWrite.$executeRaw`
        UPDATE "ModelVersion" mv
        SET status = 'Draft', meta = jsonb_set(jsonb_set(meta, '{unpublishedReason}', '"no-posts"'), '{unpublishedAt}', to_jsonb(now()))
        WHERE mv.id IN (${Prisma.join(modelVersionIds)})
      `;
    }

    // Get all published model versions that have no files
    const modelVersionsWithoutFiles = await dbWrite.$queryRaw<{ modelVersionId: number }[]>`
      SELECT
        mv.id "modelVersionId"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE
        mv.status = 'Published'
        AND m."deletedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "ModelFile" f WHERE f."modelVersionId" = mv.id);
    `;
    if (modelVersionsWithoutFiles.length) {
      // Unpublish all model versions that have no files and flag them for notification
      const modelVersionIds = modelVersionsWithoutFiles.map((r) => r.modelVersionId);
      const tasks = chunk(modelVersionIds, 500).map((batch, i) => async () => {
        console.log(`Processing batch ${i + 1}`);
        await dbWrite.$executeRaw`
          UPDATE "ModelVersion" mv
          SET status = 'Draft', meta = jsonb_set(jsonb_set(meta, '{unpublishedReason}', '"no-files"'), '{unpublishedAt}', to_jsonb(now()))
          WHERE mv.id IN (${Prisma.join(batch)})
        `;
      });
      await limitConcurrency(tasks, 5);
    }

    // Unpublish all models that have no published model versions
    await dbWrite.$executeRaw`
      UPDATE "Model" m
      SET
        status = 'Draft',
        meta = jsonb_set(jsonb_set(iif(jsonb_typeof(meta) != 'object', '{}', meta), '{unpublishedReason}', '"no-versions"'), '{unpublishedAt}', to_jsonb(now()))
      WHERE
        m."status" = 'Published'
        AND m."deletedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "ModelVersion" mv WHERE mv."modelId" = m.id AND mv.status = 'Published');
    `;
  }
);
