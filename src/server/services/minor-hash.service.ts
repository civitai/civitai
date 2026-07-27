import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';

export type MinorHashMatch = { modelId: number; userId: number };

// Seed set: only moderator-applied minor flags. A creator self-declaring their
// model minor must not cause other people's uploads to be flagged.
export const minorSrcCte = Prisma.sql`
  minor_src AS (
    SELECT DISTINCT mfh.hash, m."userId", m.id AS "minorModelId"
    FROM "Model" m
    JOIN "ModelVersion" mv ON mv."modelId" = m.id
    JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Model'
    JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id AND mfh.type = 'SHA256'
    WHERE m.minor AND 'minor' = ANY(m."lockedProperties")
  )
`;

export async function findMinorHashMatches(sha256: string): Promise<MinorHashMatch[]> {
  if (!sha256) return [];

  const rows = await dbRead.$queryRaw<{ id: number; userId: number }[]>`
    SELECT DISTINCT m.id, m."userId"
    FROM "ModelFileHash" mfh
    JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = 'Model'
    JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE mfh.type = 'SHA256' AND mfh.hash = ${sha256}
      AND m.minor AND 'minor' = ANY(m."lockedProperties")
  `;

  return rows.map(({ id, userId }) => ({ modelId: id, userId }));
}
