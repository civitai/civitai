import { Prisma } from '@prisma/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { MINOR_FLAG_SNAPSHOT_KEY, setModelMinor } from '~/server/services/model.service';
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

  // setModelMinor snapshots pre-state itself (source 'auto' for this activity).
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

// Each task awaits ~6-8 sequential round trips, so throughput is bounded by DB
// latency; capping simultaneous models is the only lever needed. `limit` is the
// per-call batch size, and both actions are resumable, so a large backfill is
// drained by repeated small calls rather than one long-running request.
export const DEFAULT_SWEEP_CONCURRENCY = 5;

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
  concurrency = DEFAULT_SWEEP_CONCURRENCY,
}: {
  dryRun: boolean;
  limit: number;
  concurrency?: number;
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

  await limitConcurrency(tasks, concurrency);

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
  createdAt: Date;
  minorModelId: number;
  minorModelName: string | null;
  minorUserId: number;
};

export async function getMinorHashMatchesForReview({ limit }: { limit: number }) {
  // One extra row tells us the cap truncated the queue, so the UI can say so
  // rather than silently presenting a partial list as the whole thing.
  const take = limit + 1;

  const rows = await dbRead.$queryRaw<MinorHashReviewRow[]>`
    WITH ${minorSrcCte},
    candidates AS (
      SELECT m.id AS "modelId", m.name AS "modelName", m."userId", m.status::text AS status,
             m."createdAt",
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
      GROUP BY m.id, m.name, m."userId", m.status, m."createdAt"
    )
    SELECT c."modelId", c."modelName", c."userId", u.username, c.status, c.hash, c."createdAt",
           s."minorModelId", mm.name AS "minorModelName", s."userId" AS "minorUserId"
    FROM candidates c
    JOIN LATERAL (
      SELECT s2."minorModelId", s2."userId"
      FROM minor_src s2
      WHERE s2.hash = c.hash AND s2."userId" <> c."userId"
      ORDER BY s2."minorModelId"
      LIMIT 1
    ) s ON TRUE
    LEFT JOIN "Model" mm ON mm.id = s."minorModelId"
    LEFT JOIN "User" u ON u.id = c."userId"
    WHERE NOT c."sameUploader"
    ORDER BY c."modelId"
    LIMIT ${take}
  `;

  // The client sorts and filters this set, so the server order is just a stable
  // default.
  return { items: rows.slice(0, limit), truncated: rows.length > limit };
}

export type MinorHashMatchDetail = {
  modelCoverUrl: string | null;
  modelCoverType: string | null;
  modelCreatedAt: Date | null;
  uploaderModelCount: number;
  uploaderJoinedAt: Date | null;
  minorModelCoverUrl: string | null;
  minorModelCoverType: string | null;
  minorModelStatus: string | null;
  minorUsername: string | null;
  minorFlaggedAt: Date | null;
  minorFlaggedByUsername: string | null;
};

// Fetched per-row on expand rather than joined into the list query: covers,
// uploader counts and flag provenance are all per-model lookups that would turn
// a 25-row page into 25x that work for detail most rows never show.
export async function getMinorHashMatchDetail({
  modelId,
  minorModelId,
}: {
  modelId: number;
  minorModelId: number;
}) {
  const coverSql = (id: number, field: 'url' | 'type') => Prisma.sql`
    (SELECT i.${Prisma.raw(`"${field}"`)}::text
     FROM "ModelVersion" mv
     JOIN "Post" p ON p."modelVersionId" = mv.id
     JOIN "Image" i ON i."postId" = p.id
     WHERE mv."modelId" = ${id}
     ORDER BY i.index NULLS LAST, i.id
     LIMIT 1)
  `;

  const [detail] = await dbRead.$queryRaw<MinorHashMatchDetail[]>`
    SELECT
      ${coverSql(modelId, 'url')} AS "modelCoverUrl",
      ${coverSql(modelId, 'type')} AS "modelCoverType",
      m."createdAt" AS "modelCreatedAt",
      (SELECT count(*)::int FROM "Model" om WHERE om."userId" = m."userId" AND om.status <> 'Deleted')
        AS "uploaderModelCount",
      u."createdAt" AS "uploaderJoinedAt",
      ${coverSql(minorModelId, 'url')} AS "minorModelCoverUrl",
      ${coverSql(minorModelId, 'type')} AS "minorModelCoverType",
      mm.status::text AS "minorModelStatus",
      mu.username AS "minorUsername",
      ma."createdAt" AS "minorFlaggedAt",
      fu.username AS "minorFlaggedByUsername"
    FROM "Model" m
    LEFT JOIN "User" u ON u.id = m."userId"
    LEFT JOIN "Model" mm ON mm.id = ${minorModelId}
    LEFT JOIN "User" mu ON mu.id = mm."userId"
    LEFT JOIN "ModActivity" ma
      ON ma."entityType" = 'model' AND ma."entityId" = ${minorModelId} AND ma.activity = 'setMinor'
    LEFT JOIN "User" fu ON fu.id = ma."userId"
    WHERE m.id = ${modelId}
  `;

  return detail ?? null;
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

type RollbackCandidateRow = {
  modelId: number;
  prevNsfw: boolean;
  prevSfwOnly: boolean;
  prevGalleryLevel: number | null;
  prevLockedProperties: string[];
  prevMinorImageIds: number[];
};

// A moderator has since reviewed and affirmed the flag by hand (a later
// `ModActivity` row with activity = 'setMinor') — their decision must stand.
// Excluded in SQL rather than filtered after the fact: these rows keep their
// meta key forever, so leaving them inside the `ORDER BY id LIMIT n` window
// would let them permanently occupy slots and stall the drain once enough of
// them accumulate below the limit.
const humanConfirmedPredicate = Prisma.sql`
  EXISTS (
    SELECT 1 FROM "ModActivity" ma
    WHERE ma."entityType" = 'model'
      AND ma."entityId" = m.id
      AND ma.activity = 'setMinor'
      AND ma."createdAt" > (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz
  )
`;

// A blanket rollback undoes the automation's decisions only. Manual flags are
// snapshotted too (so they CAN be undone), but only ever by an explicit
// `modelIds` request — a moderator's deliberate call must never be reverted as
// collateral of "undo the backfill".
const autoFlaggedPredicate = Prisma.sql`
  m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'source' IS DISTINCT FROM 'manual'
`;

export type RollbackOutcome = 'rolledBack' | 'skipped' | 'failed';
export type RollbackSample = { modelId: number; outcome: RollbackOutcome };

export type RollbackReport = {
  candidates: number;
  rolledBack: number;
  skipped: number;
  failed: number;
  sample: RollbackSample[];
};

export async function rollbackMinorHashAutoFlags({
  dryRun,
  limit,
  concurrency = DEFAULT_SWEEP_CONCURRENCY,
  modelIds,
}: {
  dryRun: boolean;
  limit: number;
  concurrency?: number;
  /**
   * Targeted mode. Rolls back exactly these models regardless of flag source,
   * and without the human-confirmation skip — naming a model IS the deliberate
   * decision that skip exists to protect.
   */
  modelIds?: number[];
}): Promise<RollbackReport> {
  const targeted = Boolean(modelIds?.length);

  // Counted uncapped and separately from the candidate window: `skipped` describes
  // the whole confirmed population, so an operator draining in batches can tell
  // "nothing left to undo" (candidates 0) from "everything left is a human call".
  // Targeted runs skip nothing, so the count is moot there.
  const [confirmed] = targeted
    ? [{ total: 0, ids: [] as number[] }]
    : await dbRead.$queryRaw<{ total: number; ids: number[] }[]>`
        WITH confirmed AS (
          SELECT m.id
          FROM "Model" m
          WHERE m.meta ? ${MINOR_FLAG_SNAPSHOT_KEY}
            AND ${autoFlaggedPredicate}
            AND ${humanConfirmedPredicate}
        )
        SELECT (SELECT count(*)::int FROM confirmed) AS total,
               COALESCE(
                 (SELECT array_agg(id ORDER BY id) FROM (SELECT id FROM confirmed ORDER BY id LIMIT 20) t),
                 ARRAY[]::int[]
               ) AS ids
      `;

  const scope = targeted
    ? Prisma.sql`m.id = ANY(${modelIds}::int[])`
    : Prisma.sql`${autoFlaggedPredicate} AND NOT ${humanConfirmedPredicate}`;

  const rows = await dbRead.$queryRaw<RollbackCandidateRow[]>`
    SELECT m.id AS "modelId",
           (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevNsfw')::boolean AS "prevNsfw",
           (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevSfwOnly')::boolean AS "prevSfwOnly",
           (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevGalleryLevel')::int AS "prevGalleryLevel",
           ARRAY(
             SELECT jsonb_array_elements_text(m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->'prevLockedProperties')
           ) AS "prevLockedProperties",
           ARRAY(
             SELECT (jsonb_array_elements_text(m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->'prevMinorImageIds'))::int
           ) AS "prevMinorImageIds"
    FROM "Model" m
    WHERE m.meta ? ${MINOR_FLAG_SNAPSHOT_KEY}
      AND ${scope}
    ORDER BY m.id
    LIMIT ${limit}
  `;

  const report: RollbackReport = {
    candidates: rows.length,
    rolledBack: 0,
    skipped: confirmed?.total ?? 0,
    failed: 0,
    sample: [],
  };

  const addSample = (modelId: number, outcome: RollbackOutcome) => {
    if (report.sample.length < 20) report.sample.push({ modelId, outcome });
  };

  // Appended last so processed models keep priority on the 20 sample slots.
  const addConfirmedSamples = () => {
    for (const modelId of confirmed?.ids ?? []) addSample(modelId, 'skipped');
  };

  if (dryRun) {
    for (const row of rows) {
      report.rolledBack++;
      addSample(row.modelId, 'rolledBack');
    }
    addConfirmedSamples();
    return report;
  }

  const tasks = rows.map((row) => async () => {
    try {
      // Reuses setModelMinor's own machinery (search index, caches, image
      // propagation) instead of hand-rolling the unset — it also clears every
      // image's `minor`, including ones legitimately minor beforehand, which is
      // why prevMinorImageIds gets re-marked afterward.
      await setModelMinor({
        id: row.modelId,
        minor: false,
        userId: SYSTEM_USER_ID,
        activity: 'rollbackMinorAutoHash',
      });

      await dbWrite.$executeRaw`
        UPDATE "Model"
        SET nsfw = ${row.prevNsfw},
            "sfwOnly" = ${row.prevSfwOnly},
            "gallerySettings" = CASE
              WHEN ${row.prevGalleryLevel}::int IS NULL
                THEN COALESCE("gallerySettings", '{}'::jsonb) - 'level'
              ELSE COALESCE("gallerySettings", '{}'::jsonb)
                || jsonb_build_object('level', ${row.prevGalleryLevel}::int)
            END,
            "lockedProperties" = ${row.prevLockedProperties}::text[],
            meta = COALESCE(meta, '{}'::jsonb) - ${MINOR_FLAG_SNAPSHOT_KEY}
        WHERE id = ${row.modelId}
      `;

      if (row.prevMinorImageIds.length) {
        await dbWrite.$executeRaw`
          UPDATE "Image" SET minor = true WHERE id = ANY(${row.prevMinorImageIds}::int[])
        `;
        await queueImageSearchIndexUpdate({
          ids: row.prevMinorImageIds,
          action: SearchIndexUpdateQueueAction.Update,
        });
      }

      report.rolledBack++;
      addSample(row.modelId, 'rolledBack');
    } catch (error) {
      report.failed++;
      addSample(row.modelId, 'failed');
      logToAxiom(
        {
          type: 'error',
          name: 'minor-hash-rollback',
          message: error instanceof Error ? error.message : String(error),
          modelId: row.modelId,
        },
        'webhooks'
      ).catch(() => null);
    }
  });

  await limitConcurrency(tasks, concurrency);
  addConfirmedSamples();

  await logToAxiom(
    {
      type: 'info',
      name: 'minor-hash-rollback',
      message: 'rollback complete',
      candidates: report.candidates,
      rolledBack: report.rolledBack,
      skipped: report.skipped,
      failed: report.failed,
    },
    'webhooks'
  ).catch(() => null);

  return report;
}
