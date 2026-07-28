import { Prisma } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { setModelMinor } from '~/server/services/model.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

export type MinorHashMatch = { modelId: number; userId: number };

// Deliberately the main weights only, not the broader `primaryModelFileTypes`
// list: widening adds a single minor-locked model in prod, and this drives an
// irreversible auto-flag. Shared by the scan-hook gate and every query below so
// the three entry points cannot select different populations.
export const MINOR_HASH_FILE_TYPE = 'Model';

// Seed set: only moderator-applied minor flags. A creator self-declaring their
// model minor must not cause other people's uploads to be flagged.
export const minorSrcCte = Prisma.sql`
  minor_src AS (
    SELECT DISTINCT mfh.hash, m."userId", m.id AS "minorModelId"
    FROM "Model" m
    JOIN "ModelVersion" mv ON mv."modelId" = m.id
    JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = ${MINOR_HASH_FILE_TYPE}
    JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id AND mfh.type = 'SHA256'
    WHERE m.minor AND 'minor' = ANY(m."lockedProperties")
  )
`;

// Shared by the sweep's count and its limited select so the totals always
// describe the same population the writes are drawn from.
export const minorHashCandidatesCte = Prisma.sql`
  candidates AS (
    SELECT m.id AS "modelId", m."userId",
           bool_or(EXISTS (
             SELECT 1 FROM minor_src s WHERE s.hash = mfh.hash AND s."userId" = m."userId"
           )) AS "sameUploader"
    FROM "ModelFileHash" mfh
    JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = ${MINOR_HASH_FILE_TYPE}
    JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE mfh.type = 'SHA256'
      AND mfh.hash IN (SELECT hash FROM minor_src)
      AND NOT m.minor
      AND m.status <> 'Deleted'
    GROUP BY m.id, m."userId"
  )
`;

export async function findMinorHashMatches(sha256: string): Promise<MinorHashMatch[]> {
  if (!sha256) return [];

  const rows = await dbRead.$queryRaw<{ id: number; userId: number }[]>`
    SELECT DISTINCT m.id, m."userId"
    FROM "ModelFileHash" mfh
    JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = ${MINOR_HASH_FILE_TYPE}
    JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE mfh.type = 'SHA256' AND mfh.hash = ${sha256.toUpperCase()}
      AND m.minor AND 'minor' = ANY(m."lockedProperties")
  `;

  return rows.map(({ id, userId }) => ({ modelId: id, userId }));
}

const SYSTEM_USER_ID = constants.system.user.id;

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
    const outcome = await applyMinorHashMatch({ modelId, userId, matches });

    if (outcome === 'flagged') {
      logToAxiom(
        {
          type: 'info',
          name: 'minor-hash-scan-check',
          message: 'flagged',
          modelId,
          userId,
          sha256,
        },
        'webhooks'
      ).catch(() => null);
    }

    return outcome;
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
  // `limit` caps writes, so the returned slice is same-uploader rows only. The
  // report's totals therefore come from a separate uncapped count — otherwise a
  // dry run would describe its own window instead of the real population.
  const [totals] = await dbRead.$queryRaw<{ candidates: number; sameUploader: number }[]>`
    WITH ${minorSrcCte},
    ${minorHashCandidatesCte}
    SELECT count(*)::int AS "candidates",
           count(*) FILTER (WHERE c."sameUploader")::int AS "sameUploader"
    FROM candidates c
  `;

  const rows = await dbRead.$queryRaw<SweepCandidate[]>`
    WITH ${minorSrcCte},
    ${minorHashCandidatesCte}
    SELECT c."modelId", c."userId", c."sameUploader"
    FROM candidates c
    WHERE c."sameUploader"
    ORDER BY c."modelId"
    LIMIT ${limit}
  `;

  const report: SweepReport = {
    candidates: totals?.candidates ?? 0,
    sameUploader: totals?.sameUploader ?? 0,
    differentUploader: (totals?.candidates ?? 0) - (totals?.sameUploader ?? 0),
    flagged: 0,
    failed: 0,
    sample: rows.slice(0, 20),
  };

  if (dryRun) return report;

  const tasks = rows.map((row) => async () => {
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

  // Logged here rather than by the caller so an HTTP timeout on a long backfill
  // cannot lose the record of writes that already committed.
  await logToAxiom(
    {
      type: 'info',
      name: 'minor-hash-sweep',
      message: 'sweep complete',
      candidates: report.candidates,
      sameUploader: report.sameUploader,
      differentUploader: report.differentUploader,
      flagged: report.flagged,
      failed: report.failed,
    },
    'webhooks'
  ).catch(() => null);

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
      JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = ${MINOR_HASH_FILE_TYPE}
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
