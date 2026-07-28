import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { setModelMinor } from '~/server/services/model.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

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

const SYSTEM_USER_ID = -1;

export type MinorHashOutcome = 'flagged' | 'queued' | 'skipped';

export async function applyMinorHashMatch({
  modelId,
  userId,
  matches,
}: {
  modelId: number;
  userId: number;
  matches: MinorHashMatch[];
}): Promise<MinorHashOutcome> {
  if (matches.some((match) => match.modelId === modelId)) return 'skipped';

  const others = matches.filter((match) => match.modelId !== modelId);
  if (!others.length) return 'skipped';
  if (!others.some((match) => match.userId === userId)) return 'queued';

  await setModelMinor({
    id: modelId,
    minor: true,
    userId: SYSTEM_USER_ID,
    activity: 'setMinorAutoHash',
  });

  return 'flagged';
}

export async function checkMinorHashOnScan({
  modelId,
  userId,
  sha256,
}: {
  modelId: number;
  userId: number;
  sha256: string;
}): Promise<MinorHashOutcome> {
  try {
    const matches = await findMinorHashMatches(sha256);
    return await applyMinorHashMatch({ modelId, userId, matches });
  } catch (error) {
    logToAxiom(
      {
        type: 'warning',
        name: 'minor-hash-scan-check',
        message: error instanceof Error ? error.message : String(error),
        modelId,
        userId,
        sha256,
      },
      'webhooks'
    ).catch(() => null);
    return 'skipped';
  }
}

export type SweepCandidate = { modelId: number; userId: number; sameUploader: boolean };

export type SweepReport = {
  candidates: number;
  sameUploader: number;
  differentUploader: number;
  flagged: number;
  failed: number;
  sample: SweepCandidate[];
};

export async function sweepMinorHashMatches({
  dryRun,
  limit,
}: {
  dryRun: boolean;
  limit: number;
}): Promise<SweepReport> {
  const rows = await dbRead.$queryRaw<SweepCandidate[]>`
    WITH ${minorSrcCte},
    candidates AS (
      SELECT m.id AS "modelId", m."userId",
             bool_or(EXISTS (
               SELECT 1 FROM minor_src s WHERE s.hash = mfh.hash AND s."userId" = m."userId"
             )) AS "sameUploader"
      FROM "ModelFileHash" mfh
      JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = 'Model'
      JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE mfh.type = 'SHA256'
        AND mfh.hash IN (SELECT hash FROM minor_src)
        AND NOT m.minor
        AND m.status <> 'Deleted'
      GROUP BY m.id, m."userId"
    )
    SELECT c."modelId", c."userId", c."sameUploader"
    FROM candidates c
    ORDER BY c."modelId"
    LIMIT ${limit}
  `;

  const sameUploader = rows.filter((row) => row.sameUploader);
  const report: SweepReport = {
    candidates: rows.length,
    sameUploader: sameUploader.length,
    differentUploader: rows.length - sameUploader.length,
    flagged: 0,
    failed: 0,
    sample: rows.slice(0, 20),
  };

  if (dryRun) return report;

  const tasks = sameUploader.map((row) => async () => {
    try {
      await setModelMinor({
        id: row.modelId,
        minor: true,
        userId: SYSTEM_USER_ID,
        activity: 'setMinorAutoHash',
      });
      report.flagged++;
    } catch (error) {
      report.failed++;
      logToAxiom(
        {
          type: 'error',
          name: 'minor-hash-sweep',
          message: error instanceof Error ? error.message : String(error),
          modelId: row.modelId,
        },
        'webhooks'
      ).catch(() => null);
    }
  });

  await limitConcurrency(tasks, 5);

  return report;
}

export type MinorHashReviewRow = {
  modelId: number;
  modelName: string;
  userId: number;
  username: string | null;
  status: string;
  hash: string;
  minorModelId: number;
  minorUserId: number;
};

export async function getMinorHashMatchesForReview({
  page,
  limit,
}: {
  page: number;
  limit: number;
}) {
  const offset = (page - 1) * limit;

  const items = await dbRead.$queryRaw<MinorHashReviewRow[]>`
    WITH ${minorSrcCte},
    candidates AS (
      SELECT m.id AS "modelId", m.name AS "modelName", m."userId", m.status::text AS status,
             bool_or(EXISTS (
               SELECT 1 FROM minor_src s WHERE s.hash = mfh.hash AND s."userId" = m."userId"
             )) AS "sameUploader",
             min(mfh.hash) AS hash
      FROM "ModelFileHash" mfh
      JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = 'Model'
      JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE mfh.type = 'SHA256'
        AND mfh.hash IN (SELECT hash FROM minor_src)
        AND NOT m.minor
        AND m.status <> 'Deleted'
        AND NOT (m.meta ? 'minorHashDismissed')
      GROUP BY m.id, m.name, m."userId", m.status
    )
    SELECT c."modelId", c."modelName", c."userId", u.username, c.status, c.hash,
           s."minorModelId", s."userId" AS "minorUserId"
    FROM candidates c
    JOIN LATERAL (
      SELECT s2."minorModelId", s2."userId"
      FROM minor_src s2
      WHERE s2.hash = c.hash AND s2."userId" <> c."userId"
      ORDER BY s2."minorModelId"
      LIMIT 1
    ) s ON TRUE
    LEFT JOIN "User" u ON u.id = c."userId"
    WHERE NOT c."sameUploader"
    ORDER BY c."modelId"
    LIMIT ${limit} OFFSET ${offset}
  `;

  return { items };
}

export async function dismissMinorHashMatch({
  modelId,
  userId,
}: {
  modelId: number;
  userId: number;
}) {
  await dbWrite.$executeRaw`
    UPDATE "Model"
    SET meta = COALESCE(meta, '{}'::jsonb)
      || jsonb_build_object('minorHashDismissed', jsonb_build_object('at', now(), 'by', ${userId}))
    WHERE id = ${modelId}
  `;

  await trackModActivity(userId, {
    entityType: 'model',
    entityId: modelId,
    activity: 'dismissMinorHashMatch',
  });
}
