import { createJob } from './job';
import { dbWrite } from '~/server/db/client';

export const addOnDemandRunStrategiesJob = createJob(
  'add-on-demand-run-strategies',
  '33 * * * *',
  async () => {
    await dbWrite.$transaction(async (tx) => {
      // Add new
      await tx.$executeRawUnsafe(`
        INSERT INTO "RunStrategy" ("partnerId", "modelVersionId", "url")
        SELECT "partnerId", "modelVersionId", "url"
        FROM "OnDemandRunStrategy" s
        WHERE NOT EXISTS (
          SELECT 1 FROM "RunStrategy"
          WHERE "partnerId" = s."partnerId" AND "modelVersionId" = s."modelVersionId"
        );
      `);

      // Update existing
      await tx.$executeRawUnsafe(`
        UPDATE "RunStrategy" t
        SET "url" = s."url"
        FROM "OnDemandRunStrategy" s
        WHERE t."partnerId" = s."partnerId" AND t."modelVersionId" = s."modelVersionId";
      `);

      // Delete old
      await tx.$executeRawUnsafe(`
        DELETE FROM "RunStrategy" t
        USING "Partner" p
        WHERE
          p.id = t."partnerId"
          AND p."onDemand" = TRUE
          AND NOT EXISTS (SELECT 1 FROM "OnDemandRunStrategy" WHERE "modelVersionId" = t."modelVersionId" AND "partnerId" = t."partnerId");
      `);
    });
  }
);
