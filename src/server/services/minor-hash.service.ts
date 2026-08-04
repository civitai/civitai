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

// What makes a model's hashes count as "known minor". Only a human decision
// qualifies:
//
//   - `minor AND 'minor' = ANY(lockedProperties)` keeps a creator from
//     self-declaring their way into seeding other people's uploads, and
//   - excluding source='auto' keeps the machine from seeding itself.
//
// Without that second clause an auto-flagged model becomes a seed, contributing
// EVERY hash on it — including ones no moderator ever tied to minor content — so
// the seed set grows from automated decisions and a dry run can't predict what
// later rounds will match. Measured on the dev clone: dry run said 300, the
// drain wrote 302. It matters more than the count suggests because `minor` lives
// on Model, not ModelVersion: one matching file restricts every version of that
// model, so each extra flag is far wider than the hash that triggered it.
//
// One definition, used by both the scan-time lookup and the CTE below — they
// were duplicated and could silently disagree about what a seed is.
const moderatorMinorSeedPredicate = Prisma.sql`
  m.minor
  AND 'minor' = ANY(m."lockedProperties")
  AND m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'source' IS DISTINCT FROM 'auto'
`;

export const MINOR_HASH_CLEARED_KEY = 'minorHashCleared';

export const MINOR_HASH_ACCEPTED_KEY = 'minorHashAccepted';

// An unreviewed auto-flag is presumed correct once the owner has had a month to
// contest it. Without a bound the queue only grows — one dev-clone sweep alone
// added 290 rows.
export const AUTO_FLAG_REVIEW_WINDOW_DAYS = 30;

// A rollback is a human deciding the model is NOT minor, and the rollback deletes
// the snapshot — so without a separate record of it the model drops straight back
// into the candidate set and the next unattended run flags it again. Verified on
// dev: rolled a model back, the scan hook re-flagged it five minutes later.
//
// Scoped by time rather than excluding the model outright: a file uploaded AFTER
// the rollback is a fresh act by the uploader, not the decision that was
// reverted, so it can still be caught. Otherwise one revert would blind the
// automation to that model permanently.
const notMinorHashClearedPredicate = Prisma.sql`
  (
    NOT (m.meta ? ${MINOR_HASH_CLEARED_KEY})
    OR mf."createdAt" > (m.meta->${MINOR_HASH_CLEARED_KEY}->>'at')::timestamptz
  )
`;

export const minorSrcCte = Prisma.sql`
  minor_src AS (
    SELECT DISTINCT mfh.hash, m."userId", m.id AS "minorModelId"
    FROM "Model" m
    JOIN "ModelVersion" mv ON mv."modelId" = m.id
    JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = ${MINOR_HASH_FILE_TYPE}
    JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id AND mfh.type = 'SHA256'
    WHERE ${moderatorMinorSeedPredicate}
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
      AND ${notMinorHashClearedPredicate}
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
      AND ${moderatorMinorSeedPredicate}
  `;

  return rows.map(({ id, userId }) => ({ modelId: id, userId }));
}

const SYSTEM_USER_ID = constants.system.user.id;

export type MinorHashOutcome = 'flagged' | 'queued' | 'skipped';

// The sweep gets this via `notMinorHashClearedPredicate` inside its candidate CTE,
// but the scan path can't: the match query's `m` is the SEED side, while the model
// a clear applies to is the one being scanned.
async function isMinorHashClearedForFile({
  modelId,
  fileId,
}: {
  modelId: number;
  fileId: number;
}): Promise<boolean> {
  const rows = await dbRead.$queryRaw<{ cleared: boolean }[]>`
    SELECT mf."createdAt" <= (m.meta->${MINOR_HASH_CLEARED_KEY}->>'at')::timestamptz AS cleared
    FROM "Model" m
    JOIN "ModelFile" mf ON mf.id = ${fileId}
    WHERE m.id = ${modelId}
      AND m.meta ? ${MINOR_HASH_CLEARED_KEY}
  `;

  return rows[0]?.cleared === true;
}

export async function applyMinorHashMatch({
  modelId,
  userId,
  fileId,
  matches,
}: {
  modelId: number;
  userId: number;
  fileId: number;
  matches: MinorHashMatch[];
}): Promise<MinorHashOutcome> {
  if (matches.some((match) => match.modelId === modelId)) return 'skipped';

  const others = matches.filter((match) => match.modelId !== modelId);
  if (!others.length) return 'skipped';
  if (!others.some((match) => match.userId === userId)) return 'queued';

  // Only the write path pays for the clear lookup — nearly every scan has already
  // returned above.
  if (await isMinorHashClearedForFile({ modelId, fileId })) return 'skipped';

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
  fileId,
  sha256,
}: {
  modelId: number;
  userId: number;
  fileId: number;
  sha256: string;
}): Promise<MinorHashOutcome> {
  try {
    const matches = await findMinorHashMatches(sha256);
    const outcome = await applyMinorHashMatch({ modelId, userId, fileId, matches });

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
  modelVersionId: number | null;
  minorModelId: number;
  minorModelName: string | null;
  minorUserId: number;
  minorModelVersionId: number | null;
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
             -- Same ORDER BY in both aggregates so element [1] of each comes from
             -- the same row: the reported version is the one carrying the
             -- reported hash, not just any version of the model.
             (array_agg(mfh.hash ORDER BY mfh.hash, mv.id))[1] AS hash,
             (array_agg(mv.id ORDER BY mfh.hash, mv.id))[1] AS "modelVersionId"
      FROM "ModelFileHash" mfh
      JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = ${MINOR_HASH_FILE_TYPE}
      JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE mfh.type = 'SHA256'
        AND mfh.hash IN (SELECT hash FROM minor_src)
        AND NOT m.minor
        AND m.status <> 'Deleted'
        AND NOT (m.meta ? 'minorHashDismissed')
        -- A targeted rollback of a manual flag applied from this very queue would
        -- otherwise put the model straight back on it.
        AND ${notMinorHashClearedPredicate}
      GROUP BY m.id, m.name, m."userId", m.status, m."createdAt"
    )
    SELECT c."modelId", c."modelName", c."userId", u.username, c.status, c.hash, c."createdAt",
           c."modelVersionId",
           s."minorModelId", mm.name AS "minorModelName", s."userId" AS "minorUserId",
           -- Resolved here rather than carried through minor_src: that CTE is shared
           -- with the sweep, and widening its DISTINCT would change its cardinality.
           (SELECT mv2.id
            FROM "ModelFileHash" h2
            JOIN "ModelFile" f2 ON f2.id = h2."fileId" AND f2.type = ${MINOR_HASH_FILE_TYPE}
            JOIN "ModelVersion" mv2 ON mv2.id = f2."modelVersionId"
            WHERE h2.type = 'SHA256' AND h2.hash = c.hash AND mv2."modelId" = s."minorModelId"
            ORDER BY mv2.id
            LIMIT 1) AS "minorModelVersionId"
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
  minorModelDeletedAt: Date | null;
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
      mm."deletedAt" AS "minorModelDeletedAt",
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

export type AutoFlaggedMinorMatch = {
  minorModelId: number;
  minorModelName: string | null;
  minorModelVersionId: number | null;
  minorModelDeletedAt: Date | null;
  hash: string;
  modelVersionId: number | null;
};

// The auto-flag path stores no pointer to what it matched — captureMinorFlagSnapshot
// records pre-state only — so the seed is re-derived from the hash on demand. That
// also means this reports the seed's CURRENT state: if the seed has since been
// unflagged the panel goes empty, which is the signal a moderator weighing Revert
// wants, not a defect.
//
// Deliberately not `minorSrcCte`: that materializes every seed (~17k models, ~0.5s)
// and this runs per expanded row. Starting from the one model's hashes keeps it on
// `modelFileHash_hash_cs` in both directions.
export async function getAutoFlaggedMinorMatch({ modelId }: { modelId: number }) {
  const [match] = await dbRead.$queryRaw<AutoFlaggedMinorMatch[]>`
    SELECT m.id AS "minorModelId", m.name AS "minorModelName",
           smv.id AS "minorModelVersionId", m."deletedAt" AS "minorModelDeletedAt",
           mfh.hash, mv.id AS "modelVersionId"
    FROM "ModelFileHash" mfh
    JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = ${MINOR_HASH_FILE_TYPE}
    JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId" AND mv."modelId" = ${modelId}
    JOIN "ModelFileHash" smfh ON smfh.hash = mfh.hash AND smfh.type = 'SHA256'
    JOIN "ModelFile" smf ON smf.id = smfh."fileId" AND smf.type = ${MINOR_HASH_FILE_TYPE}
    JOIN "ModelVersion" smv ON smv.id = smf."modelVersionId"
    JOIN "Model" m ON m.id = smv."modelId"
    WHERE mfh.type = 'SHA256'
      AND m.id <> ${modelId}
      AND ${moderatorMinorSeedPredicate}
    ORDER BY mfh.hash, m.id, smv.id
    LIMIT 1
  `;

  return match ?? null;
}

// The Auto-flagged tab's detail panel. Two queries rather than one join so the
// second is the exact same `getMinorHashMatchDetail` the review queue expands
// with — the panels stay identical by construction, not by being kept in step.
export async function getAutoFlaggedMinorDetail({ modelId }: { modelId: number }) {
  const match = await getAutoFlaggedMinorMatch({ modelId });
  if (!match) return { match: null, detail: null };

  const detail = await getMinorHashMatchDetail({ modelId, minorModelId: match.minorModelId });
  return { match, detail };
}

export type AutoFlaggedMinorModel = {
  modelId: number;
  modelName: string;
  userId: number;
  username: string | null;
  status: string;
  flaggedAt: Date;
  prevNsfw: boolean | null;
  prevGalleryLevel: number | null;
};

// The scan hook flags same-uploader re-uploads with no human in the loop, so
// this is the queue that makes those decisions reviewable. Confirmed ones drop
// out: a later `setMinor` is the moderator signing off, and it also protects the
// model from a bulk rollback.
export async function getAutoFlaggedMinorModels({ limit }: { limit: number }) {
  const rows = await dbRead.$queryRaw<AutoFlaggedMinorModel[]>`
    SELECT m.id AS "modelId", m.name AS "modelName", m."userId", u.username,
           m.status::text AS status,
           (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz AS "flaggedAt",
           (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevNsfw')::boolean AS "prevNsfw",
           (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevGalleryLevel')::int AS "prevGalleryLevel"
    FROM "Model" m
    LEFT JOIN "User" u ON u.id = m."userId"
    WHERE m.meta ? ${MINOR_FLAG_SNAPSHOT_KEY}
      AND m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'source' = 'auto'
      AND NOT ${humanConfirmedPredicate}
      AND NOT (m.meta ? ${MINOR_HASH_ACCEPTED_KEY})
      AND (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz >
          now() - make_interval(days => ${AUTO_FLAG_REVIEW_WINDOW_DAYS})
    ORDER BY (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz DESC, m.id DESC
    LIMIT ${limit + 1}
  `;

  return { items: rows.slice(0, limit), truncated: rows.length > limit };
}

// Sign-off. Promoting the snapshot to source='manual' is what carries the whole
// decision: the model leaves this queue, a blanket rollback can no longer revert
// it, and — the part the ModActivity row alone never did — its hashes start
// seeding future matches, which is the point of a moderator affirming the flag.
// `confirmedFrom` keeps the record that it began as an automated flag, and is
// COALESCEd so a second confirm reads the already-promoted 'manual' without
// erasing that origin — the owner alert and notification both key off it.
//
// The ModActivity row is still written: it is the audit trail of who signed off,
// and it remains the only protection from a blanket rollback for a model whose
// snapshot capture failed (best-effort) and therefore can't be promoted.
export async function confirmMinorHashAutoFlag({
  modelId,
  userId,
}: {
  modelId: number;
  userId: number;
}) {
  await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = jsonb_set(
      m.meta,
      ARRAY[${MINOR_FLAG_SNAPSHOT_KEY}],
      m.meta->${MINOR_FLAG_SNAPSHOT_KEY} || jsonb_build_object(
        'source', 'manual',
        'confirmedFrom', COALESCE(
          m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->'confirmedFrom',
          m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->'source'
        ),
        'confirmedAt', now(),
        'confirmedBy', ${userId}
      )
    )
    WHERE m.id = ${modelId}
      AND m.meta ? ${MINOR_FLAG_SNAPSHOT_KEY}
  `;

  await trackModActivity(userId, {
    entityType: 'model',
    entityId: modelId,
    activity: 'setMinor',
  });
}

export async function revertMinorHashAutoFlag({
  modelId,
  userId,
}: {
  modelId: number;
  userId: number;
}) {
  const report = await rollbackMinorHashAutoFlags({
    dryRun: false,
    limit: 1,
    modelIds: [modelId],
  });

  await trackModActivity(userId, {
    entityType: 'model',
    entityId: modelId,
    activity: 'rollbackMinorAutoHash',
  });

  return report;
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

// Aging out of the review window is itself a decision that the flag stands, so a
// blanket rollback must leave it alone for the same reason it leaves a moderator's
// confirmation alone. A targeted `modelIds` request still overrides — naming the
// model IS the deliberate decision.
const notAcceptedPredicate = Prisma.sql`
  NOT (m.meta ? ${MINOR_HASH_ACCEPTED_KEY})
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

  // Counted uncapped and separately from the candidate window: `skipped` must be the
  // complement of `scope` (auto-flagged AND (confirmed OR accepted)), so an operator
  // draining in batches can tell "nothing left to undo" (candidates 0, skipped 0) from
  // "everything left is protected" (candidates 0, skipped > 0). Targeted runs skip
  // nothing, so the count is moot there.
  const [confirmed] = targeted
    ? [{ total: 0, ids: [] as number[] }]
    : await dbRead.$queryRaw<{ total: number; ids: number[] }[]>`
        WITH confirmed AS (
          SELECT m.id
          FROM "Model" m
          WHERE m.meta ? ${MINOR_FLAG_SNAPSHOT_KEY}
            AND ${autoFlaggedPredicate}
            AND (${humanConfirmedPredicate} OR (m.meta ? ${MINOR_HASH_ACCEPTED_KEY}))
        )
        SELECT (SELECT count(*)::int FROM confirmed) AS total,
               COALESCE(
                 (SELECT array_agg(id ORDER BY id) FROM (SELECT id FROM confirmed ORDER BY id LIMIT 20) t),
                 ARRAY[]::int[]
               ) AS ids
      `;

  const scope = targeted
    ? Prisma.sql`m.id = ANY(${modelIds}::int[])`
    : Prisma.sql`${autoFlaggedPredicate} AND NOT ${humanConfirmedPredicate} AND ${notAcceptedPredicate}`;

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
            -- The snapshot goes, so the clear stamp is the only surviving record
            -- that a human said "not minor" — see notMinorHashClearedPredicate.
            meta = (COALESCE(meta, '{}'::jsonb) - ${MINOR_FLAG_SNAPSHOT_KEY})
              || jsonb_build_object(
                   ${MINOR_HASH_CLEARED_KEY}, jsonb_build_object('at', now())
                 )
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

// The 30-day window hides an unreviewed flag from the queue; this makes that
// durable. Kept as `source: 'auto'` on purpose — moderatorMinorSeedPredicate
// excludes 'auto', so a flag no human ever looked at never becomes the seed for
// further automated flags. No status filter on the Appeal check: any appeal at
// all means a human already looked, so sweeping it up as "nobody objected"
// would overwrite that decision with a presumption.
export async function acceptExpiredMinorAutoFlags({
  dryRun,
  limit,
}: {
  dryRun: boolean;
  limit: number;
}): Promise<{ accepted: number }> {
  if (dryRun) {
    const [row] = await dbRead.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM "Model" m
      WHERE m.meta ? ${MINOR_FLAG_SNAPSHOT_KEY}
        AND m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'source' = 'auto'
        AND NOT (m.meta ? ${MINOR_HASH_ACCEPTED_KEY})
        AND m.minor
        AND (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz <=
            now() - make_interval(days => ${AUTO_FLAG_REVIEW_WINDOW_DAYS})
        AND NOT EXISTS (
          SELECT 1 FROM "Appeal" a
          WHERE a."entityType" = 'Model' AND a."entityId" = m.id
        )
    `;
    return { accepted: row?.count ?? 0 };
  }

  const accepted = await dbWrite.$executeRaw`
    UPDATE "Model" SET meta = COALESCE(meta, '{}'::jsonb)
      || jsonb_build_object(${MINOR_HASH_ACCEPTED_KEY}, jsonb_build_object('at', now()))
    WHERE id IN (
      SELECT m.id
      FROM "Model" m
      WHERE m.meta ? ${MINOR_FLAG_SNAPSHOT_KEY}
        AND m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'source' = 'auto'
        AND NOT (m.meta ? ${MINOR_HASH_ACCEPTED_KEY})
        AND m.minor
        AND (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz <=
            now() - make_interval(days => ${AUTO_FLAG_REVIEW_WINDOW_DAYS})
        AND NOT EXISTS (
          SELECT 1 FROM "Appeal" a
          WHERE a."entityType" = 'Model' AND a."entityId" = m.id
        )
      ORDER BY m.id
      LIMIT ${limit}
    )
  `;

  return { accepted };
}
