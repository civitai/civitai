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
    // ExternalGeneration versions are excluded — their showcase posts may belong to
    // accounts other than the model owner (orchestration / curated content).
    const modelVersionsWithoutPosts = await dbWrite.$queryRaw<{ modelVersionId: number }[]>`
      SELECT
        mv.id "modelVersionId"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE
        mv.status = 'Published'
        AND m.status = 'Published'
        AND m."userId" != -1
        AND mv."usageControl" != 'ExternalGeneration'
        AND NOT EXISTS (SELECT 1 FROM "Post" p WHERE p."modelVersionId" = mv.id AND p."userId" = m."userId")
        AND m."deletedAt" IS NULL
        -- Private models aren't publicly discoverable, so the showcase-post
        -- requirement doesn't apply. Their training sample images getting
        -- moderation-blocked would otherwise empty the auto-created post and
        -- silently unpublish a privately-published trained LoRA.
        AND m."availability" != 'Private'::"Availability";
    `;

    if (modelVersionsWithoutPosts.length) {
      // Flag versions for notification. Trained versions reset to Draft so they
      // stay visible and recoverable in the user's Training tab — a trained
      // LoRA's showcase post can be emptied by sample-image moderation then
      // deleted by clean-if-empty, with no user intent to unpublish. Everything
      // else flips to Unpublished so a later user-initiated republish goes
      // through the controller's republish branch and the anti-bump publishedAt
      // guard stays consistent with "was public, hidden by system."
      const modelVersionIds = modelVersionsWithoutPosts.map((r) => r.modelVersionId);
      await dbWrite.$executeRaw`
        UPDATE "ModelVersion" mv
        SET status = CASE
            WHEN mv."uploadType" = 'Trained' THEN 'Draft'::"ModelStatus"
            ELSE 'Unpublished'::"ModelStatus"
          END,
          meta = jsonb_set(jsonb_set(meta, '{unpublishedReason}', '"no-posts"'), '{unpublishedAt}', to_jsonb(now())),
          availability = 'Private'
        WHERE mv.id IN (${Prisma.join(modelVersionIds)})
      `;
    }

    // Get all published model versions that have no files
    // ExternalGeneration versions are excluded — they're routed through external
    // engines (NanoBanana, Seedream, etc.) and intentionally have no model files.
    const modelVersionsWithoutFiles = await dbWrite.$queryRaw<{ modelVersionId: number }[]>`
      SELECT
        mv.id "modelVersionId"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE
        mv.status = 'Published'
        AND m."deletedAt" IS NULL
        -- Private models are never publicly listed; don't sweep them. See no-posts branch.
        AND m."availability" != 'Private'::"Availability"
        AND mv."usageControl" != 'ExternalGeneration'
        AND NOT EXISTS (SELECT 1 FROM "ModelFile" f WHERE f."modelVersionId" = mv.id);
    `;
    if (modelVersionsWithoutFiles.length) {
      // Unpublish all model versions that have no files and flag them for
      // notification. Unlike the no-posts branch, trained versions aren't
      // exempted here — a fileless version can't be republished, so there's
      // nothing to recover in the trainer.
      const modelVersionIds = modelVersionsWithoutFiles.map((r) => r.modelVersionId);
      const tasks = chunk(modelVersionIds, 500).map((batch, i) => async () => {
        console.log(`Processing batch ${i + 1}`);
        await dbWrite.$executeRaw`
          UPDATE "ModelVersion" mv
          SET
            status = 'Unpublished',
            meta = jsonb_set(jsonb_set(meta, '{unpublishedReason}', '"no-files"'), '{unpublishedAt}', to_jsonb(now())),
            availability = 'Private'
          WHERE mv.id IN (${Prisma.join(batch)})
        `;
      });
      await limitConcurrency(tasks, 5);
    }

    // Reset models left with no published version. Pure trained models go to
    // Draft (their only version was just reset above; keep the model recoverable
    // in the Training tab); everything else flips to Unpublished. See the
    // no-posts branch for the trained-vs-rest rationale.
    await dbWrite.$executeRaw`
      UPDATE "Model" m
      SET
        status = CASE
          WHEN EXISTS (SELECT 1 FROM "ModelVersion" mv WHERE mv."modelId" = m.id AND mv."uploadType" = 'Trained')
            AND NOT EXISTS (SELECT 1 FROM "ModelVersion" mv WHERE mv."modelId" = m.id AND mv."uploadType" != 'Trained')
          THEN 'Draft'::"ModelStatus"
          ELSE 'Unpublished'::"ModelStatus"
        END,
        meta = jsonb_set(jsonb_set(iif(jsonb_typeof(meta) != 'object', '{}', meta), '{unpublishedReason}', '"no-versions"'), '{unpublishedAt}', to_jsonb(now()))
      WHERE
        m."status" = 'Published'
        AND m."deletedAt" IS NULL
        -- Private models are never publicly listed; don't sweep them. See no-posts branch.
        AND m."availability" != 'Private'::"Availability"
        AND NOT EXISTS (SELECT 1 FROM "ModelVersion" mv WHERE mv."modelId" = m.id AND mv.status = 'Published');
    `;
  }
);
