import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';

export const studioWithheldWorkflowIdsSql = (userId: number, workflowIds: string[]) => Prisma.sql`
  WITH linked AS (
    SELECT m.meta->>'trainingStudioWorkflowId' AS "workflowId", m.status, m.mode, m."deletedBy"
    FROM "Model" m
    WHERE m."userId" = ${userId}
      AND m.meta->>'trainingStudioWorkflowId' = ANY(${workflowIds}::text[])
    UNION ALL
    SELECT mv.meta->>'trainingWorkflowId', m.status, m.mode, m."deletedBy"
    FROM "Model" m JOIN "ModelVersion" mv ON mv."modelId" = m.id
    WHERE m."userId" = ${userId}
      AND mv.meta->>'trainingWorkflowId' = ANY(${workflowIds}::text[])
    UNION ALL
    SELECT mf.metadata->'trainingResults'->>'workflowId', m.status, m.mode, m."deletedBy"
    FROM "Model" m
    JOIN "ModelVersion" mv ON mv."modelId" = m.id
    JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
    WHERE m."userId" = ${userId}
      AND mf.metadata->'trainingResults'->>'workflowId' = ANY(${workflowIds}::text[])
  )
  SELECT DISTINCT "workflowId" FROM linked
  WHERE mode::text = 'TakenDown'
    OR (status::text = 'Deleted' AND ("deletedBy" IS NULL OR "deletedBy" <> ${userId}))
`;

/**
 * Which of `workflowIds` trained a model of `userId`'s that is taken down, or deleted by anyone but
 * its owner: the Training Studio withholds those runs' epochs. Resolved from the model rows, never
 * from the workflow's own metadata, which its owner can rewrite.
 */
export async function studioWithheldWorkflowIds(
  userId: number,
  workflowIds: string[]
): Promise<string[]> {
  if (workflowIds.length === 0) return [];
  const rows = await dbWrite.$queryRaw<{ workflowId: string }[]>(
    studioWithheldWorkflowIdsSql(userId, workflowIds)
  );
  return rows.map((r) => r.workflowId);
}
