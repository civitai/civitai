import { dbWrite } from '~/server/db/client';
import { createJob } from './job';

export const reconcileCollectionCollaboration = createJob(
  'reconcile-collection-collaboration',
  '20 0 * * *',
  async () => {
    await dbWrite.$executeRaw`
      WITH active_member AS (
        SELECT DISTINCT cs."userId"
        FROM "CustomerSubscription" cs
        WHERE cs.status IN ('active', 'trialing')
          AND cs."currentPeriodEnd" >= NOW()
      ),
      collaborative AS (
        SELECT c.id, c."userId", c."collaborationDisabledAt"
        FROM "Collection" c
        WHERE c.mode IS NULL
          AND (
            c.write <> 'Private'
            OR EXISTS (
              SELECT 1 FROM "CollectionContributor" cc
              WHERE cc."collectionId" = c.id
                AND cc.permissions && ARRAY['ADD','MANAGE']::"CollectionContributorPermission"[]
            )
          )
      )
      UPDATE "Collection" c
      SET "collaborationDisabledAt" = CASE
        WHEN am."userId" IS NULL THEN COALESCE(col."collaborationDisabledAt", NOW())
        ELSE NULL
      END
      FROM collaborative col
      LEFT JOIN active_member am ON am."userId" = col."userId"
      WHERE c.id = col.id
        AND c."collaborationDisabledAt" IS DISTINCT FROM (CASE
          WHEN am."userId" IS NULL THEN COALESCE(col."collaborationDisabledAt", NOW())
          ELSE NULL
        END);
    `;
  }
);
