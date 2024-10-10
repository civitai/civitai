import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';

export const addOnDemandRunStrategiesJob = createJob(
  'add-on-demand-run-strategies',
  '33 * * * *',
  async () => {
    const [lastRun, setLastRun] = await getJobDate('add-on-demand-run-strategies');

    await dbWrite.$transaction(
      async (tx) => {
        // Upsert new
        await tx.$executeRaw`
        INSERT INTO "RunStrategy" ("partnerId", "modelVersionId", "url")
        SELECT "partnerId", "modelVersionId", "url"
        FROM "OnDemandRunStrategy" s
        WHERE "modelVersionLastUpdated" >= ${lastRun} OR "partnerCreatedAt" >= ${lastRun}
        ON CONFLICT("partnerId", "modelVersionId") DO UPDATE SET "url" = excluded."url";
      `;

        // Delete old
        await tx.$executeRaw`
        DELETE FROM "RunStrategy" t
        USING "Partner" p
        WHERE
          p.id = t."partnerId"
          AND p."onDemand" = TRUE
          AND NOT EXISTS (SELECT 1 FROM "OnDemandRunStrategy" WHERE "modelVersionId" = t."modelVersionId" AND "partnerId" = t."partnerId");
      `;
      },
      {
        timeout: 3 * 60 * 1000,
      }
    );

    await setLastRun();
  }
);
