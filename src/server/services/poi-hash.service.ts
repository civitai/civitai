import { Prisma } from '@prisma/client';
import { uniq } from 'lodash-es';
import type { Tracker } from '~/server/clickhouse/client';
import { constants } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { queryWithTimeout } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { logToAxiom } from '~/server/logging/client';
import { MINOR_HASH_FILE_TYPE } from '~/server/services/minor-hash.service';
import {
  MINOR_LOCKED_PROPERTIES,
  POI_FLAG_SNAPSHOT_KEY,
  POI_HASH_CLEARED_KEY,
  POI_HASH_MATCH_KEY,
  restoreOwnerFlagOverride,
  setModelPoi,
} from '~/server/services/model.service';
import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { updateModelNsfwLevels } from '~/server/services/nsfwLevels.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { asJsonbObjectSql, withoutSystemNsfwLockSql } from '~/server/utils/jsonb-object';
import { TEXT_SCAN_FLAGS_KEY } from '~/server/services/text-scan/flag-snapshot';
import { bustModelGallerySettings } from '~/server/services/creator-gallery-hidden-users.service';

const SYSTEM_USER_ID = constants.system.user.id;

/** The forward-only start: files uploaded before it are never matched. Stamped by the first enabled
 *  run; an operator may move it. */
export const POI_HASH_SINCE_KEY = 'poi-hash-match-since';

/** A model whose locked real-person flag makes its weights a seed. The flag this service applies
 *  itself does not seed until a moderator confirms it: checked on the snapshot and, in case an owner's
 *  save raced the snapshot away, on who set the flag last. Needs `m`. */
const poiSeedPredicate = Prisma.sql`
  m.poi
  AND 'poi' = ANY(m."lockedProperties")
  AND m.meta->${POI_FLAG_SNAPSHOT_KEY}->>'source' IS DISTINCT FROM 'auto'
  AND COALESCE((
    SELECT ma.activity <> 'setPoiAutoHash'
    FROM "ModActivity" ma
    WHERE ma."entityType" = 'model' AND ma."entityId" = m.id
      AND ma.activity IN ('setPoi', 'setPoiAutoHash')
    ORDER BY ma."createdAt" DESC, ma.id DESC
    LIMIT 1
  ), true)
`;

/** A text-scan verdict no moderator has ruled on or set by hand since. COALESCE: with no text-scan
 *  entry `?` yields NULL, which would read as neither. Needs `m`. */
const machineOnlySeedSql = Prisma.sql`
  COALESCE(
    m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi' ? 'workflowId'
    AND NOT (m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi' ? 'appealUpheld')
    AND NOT EXISTS (
      SELECT 1 FROM "ModActivity" ma
      WHERE ma."entityType" = 'model' AND ma."entityId" = m.id AND ma.activity = 'setPoi'
        AND ma."createdAt" >= COALESCE(
          (m.meta->${TEXT_SCAN_FLAGS_KEY}->'poi'->>'at')::timestamptz, '-infinity'::timestamptz
        )
    ),
    false
  )
`;

export type PoiHashSeed = { modelId: number; userId: number; human: boolean };

export async function findPoiHashSeeds(sha256: string): Promise<PoiHashSeed[]> {
  if (!sha256) return [];
  return dbRead.$queryRaw<PoiHashSeed[]>`
    SELECT DISTINCT m.id AS "modelId", m."userId", NOT ${machineOnlySeedSql} AS human
    FROM "ModelFileHash" mfh
    JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = ${MINOR_HASH_FILE_TYPE}
    JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE mfh.type = 'SHA256' AND mfh.hash = ${sha256.toUpperCase()}
      AND ${poiSeedPredicate}
  `;
}

export type PoiHashDecision = 'flag' | 'queue' | 'skip';

/** Automation never flags off automation: only a seed a human stands behind, from the same uploader,
 *  applies the flag. Every other match is a lead for a moderator. */
export function decidePoiHashMatch({
  modelId,
  userId,
  seeds,
}: {
  modelId: number;
  userId: number;
  seeds: PoiHashSeed[];
}): PoiHashDecision {
  const others = seeds.filter((seed) => seed.modelId !== modelId);
  if (others.length !== seeds.length || !others.length) return 'skip';
  return others.some((seed) => seed.human && seed.userId === userId) ? 'flag' : 'queue';
}

/** The cutoff, stamped to now if no run has set it yet. */
export async function getPoiHashSince(): Promise<Date> {
  const read = () => dbWrite.keyValue.findUnique({ where: { key: POI_HASH_SINCE_KEY } });
  let row = await read();
  if (!row) {
    await dbWrite.$executeRaw`
      INSERT INTO "KeyValue" (key, value)
      VALUES (${POI_HASH_SINCE_KEY}, to_jsonb((extract(epoch FROM now()) * 1000)::bigint))
      ON CONFLICT (key) DO NOTHING
    `;
    row = await read();
  }
  // Epoch ms as stamped, or an ISO date an operator wrote by hand.
  const value = row?.value;
  const since = new Date(typeof value === 'string' ? value : Number(value));
  if (Number.isNaN(since.getTime()))
    throw new Error(`${POI_HASH_SINCE_KEY} is not a date: ${JSON.stringify(value)}`);
  return since;
}

/** Whether this file on this model may be matched at all: the model is live and not already flagged
 *  or queued, the file is newer than the cutoff, and no moderator has cleared the model since. */
async function isMatchableFile({
  modelId,
  fileId,
  since,
}: {
  modelId: number;
  fileId: number;
  since: Date;
}) {
  const [row] = await dbWrite.$queryRaw<{ ok: boolean }[]>`
    SELECT TRUE AS ok
    FROM "Model" m
    JOIN "ModelFile" mf ON mf.id = ${fileId}
    WHERE m.id = ${modelId}
      AND NOT m.poi
      AND m.status <> 'Deleted'
      AND NOT (${asJsonbObjectSql('m.meta')} ? ${POI_HASH_MATCH_KEY})
      AND mf."createdAt" >= ${since}
      AND (
        NOT (${asJsonbObjectSql('m.meta')} ? ${POI_HASH_CLEARED_KEY})
        OR mf."createdAt" > (m.meta->${POI_HASH_CLEARED_KEY}->>'at')::timestamptz
      )
  `;
  return !!row?.ok;
}

async function markPoiHashMatch(modelId: number, hash: string) {
  await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = ${asJsonbObjectSql('m.meta')} || jsonb_build_object(
      ${POI_HASH_MATCH_KEY}::text, jsonb_build_object('at', now(), 'hash', ${hash}::text)
    )
    WHERE m.id = ${modelId} AND NOT m.poi
  `;
}

export type PoiHashOutcome = 'flagged' | 'queued' | 'skipped';

async function applyPoiHashDecision(
  decision: PoiHashDecision,
  { modelId, hash }: { modelId: number; hash: string }
): Promise<PoiHashOutcome> {
  if (decision === 'flag') {
    await setModelPoi({
      id: modelId,
      poi: true,
      userId: SYSTEM_USER_ID,
      activity: 'setPoiAutoHash',
    });
    return 'flagged';
  }
  if (decision === 'queue') {
    await markPoiHashMatch(modelId, hash);
    return 'queued';
  }
  return 'skipped';
}

/** The scan-time half. The caller gates it on the kill switch and the file type. */
export async function checkPoiHashOnScan({
  modelId,
  userId,
  fileId,
  sha256,
}: {
  modelId: number;
  userId: number;
  fileId: number;
  sha256: string;
}): Promise<PoiHashOutcome> {
  try {
    // First, so the first scan after the switch goes on stamps the cutoff, match or not.
    const since = await getPoiHashSince();
    const seeds = await findPoiHashSeeds(sha256);
    const decision = decidePoiHashMatch({ modelId, userId, seeds });
    if (decision === 'skip') return 'skipped';
    if (!(await isMatchableFile({ modelId, fileId, since }))) return 'skipped';
    return await applyPoiHashDecision(decision, { modelId, hash: sha256.toUpperCase() });
  } catch (error) {
    logToAxiom(
      {
        type: 'warning',
        name: 'poi-hash-scan-check',
        message: error instanceof Error ? error.message : String(error),
        modelId,
      },
      'webhooks'
    ).catch(() => null);
    return 'skipped';
  }
}

type SweepRow = { modelId: number; userId: number; fileId: number; hash: string };
type SweepResultRow = { candidates: number; backlog: number } & {
  [K in keyof SweepRow]: SweepRow[K] | null;
};

/** The sweep's one read, on the replica pool `dbRead` uses (the long-read pool can fall back to the
 *  primary). Set here rather than left to the connection's default, which differs by role. */
const SWEEP_TIMEOUT_MS = 120_000;

export type PoiHashSweepReport = {
  since: string;
  candidates: number;
  flagged: number;
  queued: number;
  failed: number;
  /** Matches on files older than the cutoff: never acted on, reported for a later decision. */
  backlog: number;
};

/**
 * Catches what the scan hook cannot: a copy uploaded after the cutoff whose seed was flagged after
 * the copy was scanned. One row per candidate model, its earliest matching file.
 */
export async function sweepPoiHashMatches({
  limit,
}: {
  limit: number;
}): Promise<PoiHashSweepReport> {
  const since = await getPoiHashSince();
  // One statement, so the CTEs are built once; driven from Model, so the seed filter runs per model
  // rather than per version or file.
  // Bound as text: the pg driver serialises a Date in the process's local offset, which a
  // timestamp-without-zone comparison would then drop.
  const sinceSql = Prisma.sql`${since.toISOString()}::timestamptz`;
  const sweep = Prisma.sql`
    WITH seed_models AS MATERIALIZED (
      SELECT m.id FROM "Model" m WHERE ${poiSeedPredicate}
    ),
    poi_src AS (
      SELECT DISTINCT mfh.hash
      FROM seed_models s
      JOIN "ModelVersion" mv ON mv."modelId" = s.id
      JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = ${MINOR_HASH_FILE_TYPE}
      JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id AND mfh.type = 'SHA256'
    ),
    matches AS MATERIALIZED (
      SELECT m.id AS "modelId", m."userId", mf.id AS "fileId", mfh.hash, mf."createdAt",
             COALESCE(
               mf."createdAt" <= (m.meta->${POI_HASH_CLEARED_KEY}->>'at')::timestamptz, false
             ) AS cleared
      FROM "ModelFileHash" mfh
      JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = ${MINOR_HASH_FILE_TYPE}
      JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE mfh.type = 'SHA256'
        AND mfh.hash IN (SELECT hash FROM poi_src)
        AND NOT m.poi
        AND m.status <> 'Deleted'
        AND NOT (${asJsonbObjectSql('m.meta')} ? ${POI_HASH_MATCH_KEY})
    ),
    totals AS (
      SELECT count(DISTINCT "modelId") FILTER (WHERE "createdAt" >= ${sinceSql} AND NOT cleared)::int
               AS candidates,
             count(DISTINCT "modelId") FILTER (WHERE "createdAt" < ${sinceSql})::int AS backlog
      FROM matches
    ),
    picked AS (
      SELECT DISTINCT ON ("modelId") "modelId", "userId", "fileId", hash
      FROM matches
      WHERE "createdAt" >= ${sinceSql} AND NOT cleared
      ORDER BY "modelId", "createdAt", "fileId"
      LIMIT ${limit}
    )
    SELECT t.candidates, t.backlog, p."modelId", p."userId", p."fileId", p.hash
    FROM totals t
    LEFT JOIN picked p ON TRUE
  `;

  // A timeout throws: logged and rethrown so the job fails, rather than reading as nothing to do.
  let result: SweepResultRow[];
  try {
    ({ rows: result } = await queryWithTimeout<SweepResultRow>(pgDbRead, SWEEP_TIMEOUT_MS, sweep));
  } catch (error) {
    await logToAxiom(
      {
        type: 'error',
        name: 'poi-hash-sweep',
        message: error instanceof Error ? error.message : String(error),
        since: since.toISOString(),
      },
      'webhooks'
    ).catch(() => null);
    throw error;
  }

  const report: PoiHashSweepReport = {
    since: since.toISOString(),
    candidates: result[0]?.candidates ?? 0,
    flagged: 0,
    queued: 0,
    failed: 0,
    backlog: result[0]?.backlog ?? 0,
  };
  const rows = result.filter((row): row is SweepResultRow & SweepRow => row.modelId !== null);

  await limitConcurrency(
    rows.map((row) => async () => {
      try {
        const seeds = await findPoiHashSeeds(row.hash);
        const decision = decidePoiHashMatch({ modelId: row.modelId, userId: row.userId, seeds });
        if (decision === 'skip') return;
        if (!(await isMatchableFile({ modelId: row.modelId, fileId: row.fileId, since }))) return;
        const outcome = await applyPoiHashDecision(decision, row);
        if (outcome === 'flagged') report.flagged++;
        if (outcome === 'queued') report.queued++;
      } catch (error) {
        report.failed++;
        logToAxiom(
          {
            type: 'error',
            name: 'poi-hash-sweep',
            message: error instanceof Error ? error.message : String(error),
            modelId: row.modelId,
          },
          'webhooks'
        ).catch(() => null);
      }
    }),
    5
  );

  await logToAxiom({ type: 'info', name: 'poi-hash-sweep', ...report }, 'webhooks').catch(
    () => null
  );
  return report;
}

/** The moderator queue's Auto-flagged rule: the flag as applied, with no moderator set since. An
 *  appeal also rules one a moderator confirmed. Needs `m`. */
const asQueuedSql = (fromAppeal?: boolean) =>
  !fromAppeal
    ? Prisma.sql`
      AND m.meta->${POI_FLAG_SNAPSHOT_KEY}->>'source' = 'auto'
      AND NOT EXISTS (
        SELECT 1 FROM "ModActivity" ma
        WHERE ma."entityType" = 'model' AND ma."entityId" = m.id AND ma.activity = 'setPoi'
          AND ma."createdAt" > (m.meta->${POI_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz
      )`
    : Prisma.empty;

/** Flags a model still waiting on its match, re-checked under the row lock: another moderator may have
 *  flagged or dismissed it since the queue was read. */
export async function flagPoiHashMatch({
  modelId,
  userId,
  tracker,
}: {
  modelId: number;
  userId: number;
  tracker?: Tracker;
}) {
  const result = await setModelPoi({
    id: modelId,
    poi: true,
    userId,
    tracker,
    isModerator: true,
    onlyIf: (row) =>
      !row.poi && row.status !== 'Deleted' && Object.hasOwn(row.meta ?? {}, POI_HASH_MATCH_KEY),
  });
  return { flagged: result ? 1 : 0 };
}

/** A moderator signs off the hash flag: its weights now seed, and the snapshot keeps its origin. */
export async function confirmPoiHashAutoFlag({
  modelId,
  userId,
  fromAppeal,
}: {
  modelId: number;
  userId: number;
  fromAppeal?: boolean;
}) {
  const confirmed = await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = jsonb_set(
      m.meta,
      ARRAY[${POI_FLAG_SNAPSHOT_KEY}::text],
      m.meta->${POI_FLAG_SNAPSHOT_KEY} || jsonb_build_object(
        'source', 'manual',
        'confirmedFrom', 'auto',
        'confirmedAt', now(),
        'confirmedBy', ${userId}::int
      )
    )
    WHERE m.id = ${modelId} AND m.poi AND m.meta ? ${POI_FLAG_SNAPSHOT_KEY}${asQueuedSql(
    fromAppeal
  )}
  `;
  if (!confirmed) return { confirmed: 0 };
  await trackModActivity(userId, { entityType: 'model', entityId: modelId, activity: 'setPoi' });
  return { confirmed };
}

type PoiSnapshotRow = {
  prevNsfw: boolean | null;
  prevSfwOnly: boolean | null;
  prevGalleryLevel: number | null;
  prevLockedProperties: string[] | null;
};

/**
 * Lifts a hash-applied flag and puts back what it changed. The lift drops the snapshot, so it is
 * read first. A model also flagged minor keeps the restrictions minor needs.
 */
export async function revertPoiHashAutoFlag({
  modelId,
  userId,
  fromAppeal,
}: {
  modelId: number;
  userId: number;
  fromAppeal?: boolean;
}) {
  const [snapshot] = await dbWrite.$queryRaw<PoiSnapshotRow[]>`
    SELECT (m.meta->${POI_FLAG_SNAPSHOT_KEY}->>'prevNsfw')::boolean AS "prevNsfw",
           (m.meta->${POI_FLAG_SNAPSHOT_KEY}->>'prevSfwOnly')::boolean AS "prevSfwOnly",
           (m.meta->${POI_FLAG_SNAPSHOT_KEY}->>'prevGalleryLevel')::int AS "prevGalleryLevel",
           ARRAY(
             SELECT jsonb_array_elements_text(m.meta->${POI_FLAG_SNAPSHOT_KEY}->'prevLockedProperties')
           ) AS "prevLockedProperties"
    FROM "Model" m
    WHERE m.id = ${modelId} AND m.poi AND m.meta ? ${POI_FLAG_SNAPSHOT_KEY}${asQueuedSql(
    fromAppeal
  )}
  `;
  if (!snapshot) return { reverted: 0 };

  // Re-checked under the lock: a confirm or another revert may have landed since the read above.
  const lifted = await setModelPoi({
    id: modelId,
    poi: false,
    userId,
    activity: 'revertPoiAutoHash',
    fromAppeal,
    onlyIf: (row) =>
      row.poi &&
      !!row.meta?.poiFlagSnapshot &&
      (!!fromAppeal || row.meta.poiFlagSnapshot.source === 'auto'),
  });
  if (!lifted) return { reverted: 0 };

  // The lift has released the lock, so each restore reads the flags as they are now: a model flagged
  // again since keeps its restrictions, and one flagged minor since keeps what minor needs.
  const prevLockedProperties = snapshot.prevLockedProperties ?? [];
  await dbWrite.$executeRaw`
    UPDATE "Model"
    SET "lockedProperties" = ${uniq([...prevLockedProperties, ...MINOR_LOCKED_PROPERTIES])}::text[],
        meta = ${withoutSystemNsfwLockSql('meta')}
    WHERE id = ${modelId} AND NOT poi AND minor
  `;
  await dbWrite.$executeRaw`
    UPDATE "Model"
    SET nsfw = COALESCE(${snapshot.prevNsfw}::boolean, nsfw),
        "sfwOnly" = COALESCE(${snapshot.prevSfwOnly}::boolean, "sfwOnly"),
        "gallerySettings" = CASE
          WHEN ${snapshot.prevGalleryLevel}::int IS NULL
            THEN COALESCE("gallerySettings", '{}'::jsonb) - 'level'
          ELSE COALESCE("gallerySettings", '{}'::jsonb)
            || jsonb_build_object('level', ${snapshot.prevGalleryLevel}::int)
        END,
        "lockedProperties" = ${prevLockedProperties}::text[],
        meta = ${withoutSystemNsfwLockSql('meta')}
    WHERE id = ${modelId} AND NOT poi AND NOT minor
  `;
  await restoreOwnerFlagOverride(modelId, { revertedFlag: 'poi' });
  await updateModelNsfwLevels([modelId]);
  await bustPublicModelResponseCache(modelId);
  // The restore moves sfwOnly and the gallery level after setModelPoi's own cache bust.
  await bustModelGallerySettings([modelId]);
  return { reverted: 1 };
}

/** Takes a lead off the queue without flagging anything. Not a verdict on the model. */
export async function dismissPoiHashMatch({
  modelId,
  userId,
}: {
  modelId: number;
  userId: number;
}) {
  const dismissed = await dbWrite.$executeRaw`
    UPDATE "Model" m
    SET meta = (${asJsonbObjectSql('m.meta')} - ${POI_HASH_MATCH_KEY}::text)
      || jsonb_build_object(${POI_HASH_CLEARED_KEY}::text, jsonb_build_object('at', now()))
    WHERE m.id = ${modelId} AND m.meta ? ${POI_HASH_MATCH_KEY} AND NOT m.poi
  `;
  if (!dismissed) return { dismissed: 0 };
  await trackModActivity(userId, {
    entityType: 'model',
    entityId: modelId,
    activity: 'dismissPoiHashMatch',
  });
  return { dismissed };
}
