import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';

/**
 * The read half of the main app's `/moderator/minor-hash-matches`, ported per
 * `docs/moderator-app/page-migration-checklist.md` (procedures -> `load`, services -> Kysely here).
 *
 * The predicates below are copied from `src/server/services/minor-hash.service.ts` **verbatim**, and
 * they must stay that way. Each queue's population is defined by exclusions that look like noise and
 * are not: `minorHashDismissed`, the cleared-stamp window, the human-confirmation check, the accepted
 * key, the 30-day review bound. A spoke that "simplifies" any of them shows a moderator a different
 * set of models from the page that writes the verdicts, while looking authoritative.
 *
 * Writes deliberately do NOT live here — see `minor-flag.service.ts`. `setModelMinor` owns the search
 * index, the caches and the per-image propagation, and the spoke owns none of those.
 */

const MINOR_HASH_FILE_TYPE = 'Model';
const MINOR_FLAG_SNAPSHOT_KEY = 'minorFlagSnapshot';
const MINOR_HASH_CLEARED_KEY = 'minorHashCleared';
const MINOR_HASH_ACCEPTED_KEY = 'minorHashAccepted';

/** Kept as a literal, not a bind: `make_interval` takes int4 and a bound JS number arrives as int8,
 *  which fails to resolve the function (42883) and 500s every query using it. */
const AUTO_FLAG_REVIEW_WINDOW_DAYS = 30;
const reviewWindowCutoff = sql`now() - make_interval(days => ${sql.raw(
  String(AUTO_FLAG_REVIEW_WINDOW_DAYS)
)})`;

/** A seed is a model a HUMAN flagged: `source = 'auto'` is excluded so the automation cannot feed
 *  itself. One definition, because the scan path and the queue had drifted copies. */
const moderatorMinorSeedPredicate = sql`
  m.minor
  AND 'minor' = ANY(m."lockedProperties")
  AND m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'source' IS DISTINCT FROM 'auto'
`;

/** A rollback deletes the snapshot, so without this the model drops straight back into the candidate
 *  set. Scoped by time rather than excluding the model forever: a file uploaded AFTER the clear is a
 *  fresh act by the uploader, not the decision that was reverted. */
const notMinorHashClearedPredicate = sql`
  (
    NOT (m.meta ? ${MINOR_HASH_CLEARED_KEY})
    OR mf."createdAt" > (m.meta->${MINOR_HASH_CLEARED_KEY}->>'at')::timestamptz
  )
`;

/** A later `setMinor` is a moderator affirming the flag by hand; their decision stands. */
const humanConfirmedPredicate = sql`
  EXISTS (
    SELECT 1 FROM "ModActivity" ma
    WHERE ma."entityType" = 'model'
      AND ma."entityId" = m.id
      AND ma.activity = 'setMinor'
      AND ma."createdAt" > (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz
  )
`;

const minorSrcCte = sql`
  minor_src AS (
    SELECT DISTINCT mfh.hash, m."userId", m.id AS "minorModelId"
    FROM "Model" m
    JOIN "ModelVersion" mv ON mv."modelId" = m.id
    JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = ${MINOR_HASH_FILE_TYPE}
    JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id AND mfh.type = 'SHA256'
    WHERE ${moderatorMinorSeedPredicate}
  )
`;

/** Offset rather than keyset. The Pending queue's order is a stable default over a set the client
 *  sorts anyway, and its shape (a CTE grouped per model, then a LATERAL) has no single monotonic
 *  column to key on. The cost is dominated by building the seed set, which every page pays anyway. */
export type Page = { limit: number; offset?: number };

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

/** Tab 1 — Pending review: a model sharing a file hash with something a human flagged as minor, where
 *  the two were uploaded by DIFFERENT accounts (`NOT sameUploader`; the same-uploader case is what the
 *  scan hook auto-flags, which is tab 2). */
export async function getMinorHashMatchesForReview({ limit, offset = 0 }: Page) {
  const rows = await sql<MinorHashReviewRow>`
    WITH ${minorSrcCte},
    candidates AS (
      SELECT m.id AS "modelId", m.name AS "modelName", m."userId", m.status::text AS status,
             m."createdAt",
             bool_or(EXISTS (
               SELECT 1 FROM minor_src s WHERE s.hash = mfh.hash AND s."userId" = m."userId"
             )) AS "sameUploader",
             -- Same ORDER BY in both aggregates so element [1] of each comes from the same row: the
             -- reported version is the one carrying the reported hash, not just any version.
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
        AND ${notMinorHashClearedPredicate}
      GROUP BY m.id, m.name, m."userId", m.status, m."createdAt"
    )
    SELECT c."modelId", c."modelName", c."userId", u.username, c.status, c.hash, c."createdAt",
           c."modelVersionId",
           s."minorModelId", mm.name AS "minorModelName", s."userId" AS "minorUserId",
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
    LIMIT ${limit + 1} OFFSET ${offset}
  `.execute(dbRead);

  // The extra row is how "there is another page" is known without a second count query.
  return { items: rows.rows.slice(0, limit), hasMore: rows.rows.length > limit };
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

/** Tab 2 — Auto-flagged: what the scan hook flagged with no human in the loop. Confirmed ones drop
 *  out, and so do accepted ones and anything past the review window — an unreviewed auto-flag is
 *  presumed correct once the owner has had a month to contest it, and without that bound the queue
 *  only grows. */
export async function getAutoFlaggedMinorModels({ limit, offset = 0 }: Page) {
  const rows = await sql<AutoFlaggedMinorModel>`
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
      AND (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz > ${reviewWindowCutoff}
    ORDER BY (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz DESC, m.id DESC
    LIMIT ${limit + 1} OFFSET ${offset}
  `.execute(dbRead);

  return { items: rows.rows.slice(0, limit), hasMore: rows.rows.length > limit };
}

export type MinorFlagAppealRow = {
  appealId: number;
  appealMessage: string;
  appealCreatedAt: Date;
  modelId: number;
  modelName: string;
  userId: number;
  username: string | null;
  status: string;
  minor: boolean;
  flaggedAt: Date | null;
  flagSource: string | null;
  flagConfirmedFrom: string | null;
  prevNsfw: boolean | null;
  prevGalleryLevel: number | null;
};

/** Tab 3 — Appeals. Deliberately NOT tab 2 narrowed by an appeal: that tab bounds itself to
 *  `source='auto'` inside 30 days and drops accepted flags, so an appeal against a moderator's own
 *  Set-as-Minor, or against a flag that has since aged out, would surface nowhere. An appeal is a
 *  human asking for review, which outranks every one of those bounds.
 *
 *  No gate on the model still being minor either: reverting from tab 2 leaves the appeal Pending, and
 *  hiding it here would strand it with nowhere left to close it. `minor` is returned so the row can
 *  show that state instead. */
export async function getMinorFlagAppealsForReview({ limit, offset = 0 }: Page) {
  const rows = await sql<MinorFlagAppealRow>`
    SELECT a.id AS "appealId", a."appealMessage", a."createdAt" AS "appealCreatedAt",
           m.id AS "modelId", m.name AS "modelName", m."userId", u.username,
           m.status::text AS status, m.minor,
           (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz AS "flaggedAt",
           m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'source' AS "flagSource",
           -- A moderator affirming an auto-flag rewrites source to 'manual', so this is the only
           -- surviving record that a hash match started it.
           m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'confirmedFrom' AS "flagConfirmedFrom",
           (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevNsfw')::boolean AS "prevNsfw",
           (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevGalleryLevel')::int AS "prevGalleryLevel"
    FROM "Appeal" a
    JOIN "Model" m ON m.id = a."entityId"
    LEFT JOIN "User" u ON u.id = m."userId"
    WHERE a."entityType" = 'Model'
      -- Cast rather than bind the enum: the value goes over as text and Postgres has no
      -- AppealStatus = text operator.
      AND a.status::text = 'Pending'
    ORDER BY a."createdAt", a.id
    LIMIT ${limit + 1} OFFSET ${offset}
  `.execute(dbRead);

  return { items: rows.rows.slice(0, limit), hasMore: rows.rows.length > limit };
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

/** Fetched per row on expand rather than joined into the list: covers, uploader counts and flag
 *  provenance are per-model lookups that would turn a 25-row page into 25x the work for detail most
 *  rows never show. */
export async function getMinorHashMatchDetail({
  modelId,
  minorModelId,
}: {
  modelId: number;
  /** Null when nothing seeded the flag — a manual Set-as-Minor. Every seed-side column then comes
   *  back null while the model's own half still loads. */
  minorModelId: number | null;
}) {
  // Every seed-side id is cast rather than left to inference: a null bind reaches Postgres untyped,
  // and `col = $1` with no type to resolve against fails.
  const cover = (id: number | null, field: 'url' | 'type') => sql`
    (SELECT i.${sql.raw(`"${field}"`)}::text
     FROM "ModelVersion" mv
     JOIN "Post" p ON p."modelVersionId" = mv.id
     JOIN "Image" i ON i."postId" = p.id
     WHERE mv."modelId" = ${id}::int
     ORDER BY i.index NULLS LAST, i.id
     LIMIT 1)
  `;

  const result = await sql<MinorHashMatchDetail>`
    SELECT
      ${cover(modelId, 'url')} AS "modelCoverUrl",
      ${cover(modelId, 'type')} AS "modelCoverType",
      m."createdAt" AS "modelCreatedAt",
      (SELECT count(*)::int FROM "Model" om WHERE om."userId" = m."userId" AND om.status <> 'Deleted')
        AS "uploaderModelCount",
      u."createdAt" AS "uploaderJoinedAt",
      ${cover(minorModelId, 'url')} AS "minorModelCoverUrl",
      ${cover(minorModelId, 'type')} AS "minorModelCoverType",
      mm.status::text AS "minorModelStatus",
      mm."deletedAt" AS "minorModelDeletedAt",
      mu.username AS "minorUsername",
      ma."createdAt" AS "minorFlaggedAt",
      fu.username AS "minorFlaggedByUsername"
    FROM "Model" m
    LEFT JOIN "User" u ON u.id = m."userId"
    LEFT JOIN "Model" mm ON mm.id = ${minorModelId}::int
    LEFT JOIN "User" mu ON mu.id = mm."userId"
    LEFT JOIN "ModActivity" ma
      ON ma."entityType" = 'model' AND ma."entityId" = ${minorModelId}::int
        AND ma.activity = 'setMinor'
    LEFT JOIN "User" fu ON fu.id = ma."userId"
    WHERE m.id = ${modelId}
  `.execute(dbRead);

  return result.rows[0] ?? null;
}

export type AutoFlaggedMinorMatch = {
  minorModelId: number;
  minorModelName: string | null;
  minorModelVersionId: number | null;
  minorModelDeletedAt: Date | null;
  hash: string;
  modelVersionId: number | null;
};

/** The auto-flag path stores no pointer to what it matched, so the seed is re-derived from the hash on
 *  demand. That also means this reports the seed's CURRENT state: if the seed has since been unflagged
 *  nothing comes back, which is the signal a moderator weighing Revert wants, not a defect.
 *
 *  Deliberately not `minorSrcCte` — that materialises every seed (~17k models, ~0.5s) and this runs per
 *  expanded row. Starting from the one model's hashes keeps it on `modelFileHash_hash_cs` both ways. */
export async function getAutoFlaggedMinorMatch({ modelId }: { modelId: number }) {
  const result = await sql<AutoFlaggedMinorMatch>`
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
  `.execute(dbRead);

  return result.rows[0] ?? null;
}

/** The Auto-flagged and Appeals tabs' detail panel. Two queries rather than one join, so the second is
 *  the exact same `getMinorHashMatchDetail` the review queue expands with — the panels stay identical
 *  by construction rather than by being kept in step.
 *
 *  The detail query runs even with no seed: a manual Set-as-Minor has no hash match by definition, and
 *  that is most of what the appeals tab reviews. Short-circuiting left those panels with no cover, no
 *  upload date and "0 models" for the uploader. */
export async function getAutoFlaggedMinorDetail({ modelId }: { modelId: number }) {
  const match = await getAutoFlaggedMinorMatch({ modelId });
  const detail = await getMinorHashMatchDetail({
    modelId,
    minorModelId: match?.minorModelId ?? null,
  });
  return { match, detail };
}

export type MinorQueueCounts = { pending: number; auto: number; appeals: number };

/**
 * Tab counts. Client-fetched and cached rather than part of `load`, because the Pending count costs
 * ~10s on its own: it has to build the same seed set and candidate CTE the queue does, then count the
 * whole population instead of one page of it. Blocking every page render on that to label three tabs
 * is the trade the row queries already refuse.
 *
 * All three in one round trip, since a moderator reads them together and a tab labelled with a count
 * from a different moment is the thing worth avoiding.
 */
const COUNTS_TTL_MS = 300_000;
let countsCache: { at: number; value: Promise<MinorQueueCounts> } | null = null;

export function getMinorQueueCounts(now = Date.now()): Promise<MinorQueueCounts> {
  if (countsCache && now - countsCache.at < COUNTS_TTL_MS) return countsCache.value;
  const value = fetchCounts();
  countsCache = { at: now, value };
  value.catch(() => {
    if (countsCache?.value === value) countsCache = null;
  });
  return value;
}

async function fetchCounts(): Promise<MinorQueueCounts> {
  const [pending, rest] = await Promise.all([
    sql<{ count: number }>`
      WITH ${minorSrcCte},
      candidates AS (
        SELECT m.id AS "modelId", m."userId",
               bool_or(EXISTS (
                 SELECT 1 FROM minor_src s WHERE s.hash = mfh.hash AND s."userId" = m."userId"
               )) AS "sameUploader",
               (array_agg(mfh.hash ORDER BY mfh.hash, mv.id))[1] AS hash
        FROM "ModelFileHash" mfh
        JOIN "ModelFile" mf ON mf.id = mfh."fileId" AND mf.type = ${MINOR_HASH_FILE_TYPE}
        JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE mfh.type = 'SHA256'
          AND mfh.hash IN (SELECT hash FROM minor_src)
          AND NOT m.minor
          AND m.status <> 'Deleted'
          AND NOT (m.meta ? 'minorHashDismissed')
          AND ${notMinorHashClearedPredicate}
        GROUP BY m.id, m."userId"
      )
      -- EXISTS rather than the queue's LATERAL join: the queue needs WHICH seed matched, a count only
      -- needs that one did, and the two agree because the LATERAL is unconditional (JOIN ... ON TRUE).
      SELECT count(*)::int AS count
      FROM candidates c
      WHERE NOT c."sameUploader"
        AND EXISTS (SELECT 1 FROM minor_src s2 WHERE s2.hash = c.hash AND s2."userId" <> c."userId")
    `.execute(dbRead),
    sql<{ auto: number; appeals: number }>`
      SELECT
        (SELECT count(*)::int FROM "Model" m
          WHERE m.meta ? ${MINOR_FLAG_SNAPSHOT_KEY}
            AND m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'source' = 'auto'
            AND NOT ${humanConfirmedPredicate}
            AND NOT (m.meta ? ${MINOR_HASH_ACCEPTED_KEY})
            AND (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz > ${reviewWindowCutoff}
        ) AS auto,
        (SELECT count(*)::int FROM "Appeal" a
          JOIN "Model" m ON m.id = a."entityId"
          WHERE a."entityType" = 'Model' AND a.status::text = 'Pending'
        ) AS appeals
    `.execute(dbRead),
  ]);

  return {
    pending: Number(pending.rows[0]?.count ?? 0),
    auto: Number(rest.rows[0]?.auto ?? 0),
    appeals: Number(rest.rows[0]?.appeals ?? 0),
  };
}
