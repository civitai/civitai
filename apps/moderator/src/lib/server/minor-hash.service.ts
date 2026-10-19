import { sql, type RawBuilder } from '@civitai/db/kysely';
import { createCache } from './cache';
import { dbRead } from './db';
import { getUserNotes } from './moderation-memory.service';
import {
  DEFAULT_APPEAL_FILTERS,
  SNAPSHOT_SOURCE,
  type AppealFilters,
  type AppealFlag,
  type AppealGroup,
  type AppealSource,
} from '$lib/minor-flags/appeal-filters';
import {
  DEFAULT_FLAGGED_FILTERS,
  type FlaggedFilters,
  type FlaggedFlag,
} from '$lib/minor-flags/flagged-filters';
import type {
  FlagLabel,
  FlagRulingView,
  LatestScan,
  LatestScanSource,
  TextScanFlagView,
  PriorClearView,
  RedetectionView,
} from '$lib/minor-flags/text-scan-verdicts';
import type { ModelFlagDetail, ScanRows } from '$lib/minor-flags/model-detail';
import type { FlaggedSource } from '$lib/minor-flags/flagged-decision';

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
export const AUTO_FLAG_REVIEW_WINDOW_DAYS = 30;
const reviewWindowCutoff = sql`now() - make_interval(days => ${sql.raw(
  String(AUTO_FLAG_REVIEW_WINDOW_DAYS)
)})`;

/** A seed is a model a HUMAN flagged: `source = 'auto'` and the unreviewed `'text-scan'` are
 *  excluded so automation cannot feed itself. One definition, because the scan path and the queue had drifted copies. */
const moderatorMinorSeedPredicate = sql`
  m.minor
  AND 'minor' = ANY(m."lockedProperties")
  AND m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'source' IS DISTINCT FROM 'auto'
  AND m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'source' IS DISTINCT FROM 'text-scan'
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

/** The scan hook's flags still inside the review window and not yet affirmed by a human. Searching a
 *  model id lifts the window for that model, so a moderator can still reach Revert once it has closed. */
const hashFlaggedPredicate = (search?: MinorSearch) => sql`
  m.meta ? ${MINOR_FLAG_SNAPSHOT_KEY}
  AND m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'source' = 'auto'
  AND NOT ${humanConfirmedPredicate}
  AND NOT (m.meta ? ${MINOR_HASH_ACCEPTED_KEY})
  AND ((m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz > ${reviewWindowCutoff}${
  search && 'modelOrUserId' in search ? sql` OR m.id = ${search.modelOrUserId}` : sql``
})
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
export type Page = { limit: number; offset?: number; search?: MinorSearch };

/** A numeric search is a model or user id; any other text is a whole username or part of a model name. */
export type MinorSearch = { modelOrUserId: number } | { text: string };

/** Needs the uploader joined as `u`. */
const joinsUploader = (search: MinorSearch | undefined) => !!search && 'text' in search;

const likeContains = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

/** A model `m` and its uploader `u`, the shape every queue but File matches searches. */
const userRefs = {
  modelId: 'm.id',
  modelName: 'm.name',
  userId: 'm.userId',
  username: 'u.username',
};

/** The name match is an unindexed ILIKE, so it only ever narrows a queue's already-filtered set. */
const searchPredicate = (
  search: MinorSearch | undefined,
  refs: { modelId: string; modelName: string; userId: string; username: string },
  orSeed?: (id: number) => RawBuilder<unknown>
) => {
  if (!search) return sql`TRUE`;
  if ('text' in search)
    return sql`(lower(${sql.ref(refs.username)}) = lower(${search.text})
      OR ${sql.ref(refs.modelName)} ILIKE ${likeContains(search.text)})`;
  const id = search.modelOrUserId;
  return sql`(${sql.ref(refs.modelId)} = ${id} OR ${sql.ref(refs.userId)} = ${id}${
    orSeed ? sql` OR ${orSeed(id)}` : sql``
  })`;
};

export type MinorHashReviewRow = {
  modelId: number;
  modelName: string;
  userId: number;
  username: string | null;
  status: string;
  hash: string;
  /** This model's file carrying the shared hash, as it named it. */
  fileName: string | null;
  fileSizeKB: number | null;
  createdAt: Date;
  modelVersionId: number | null;
  minorModelId: number;
  minorModelName: string | null;
  minorUserId: number;
  minorModelVersionId: number | null;
  modelType: string;
  modelCreatedAt: Date;
  baseModel: string | null;
  trainedWords: string[];
  trainedWordCount: number;
  tags: string[];
  tagCount: number;
  coverImages: AppealCoverImage[];
  otherFlaggedModels: number;
  pastAppeals: { approved: number; rejected: number; void: number; pending: number };
};

/** File matches: a model sharing a file hash with something a human flagged as minor, where the two
 *  were uploaded by DIFFERENT accounts (`NOT sameUploader`; the same-uploader case is what the scan
 *  hook auto-flags, which the Flagged tab lists). */
export async function getMinorHashMatchesForReview({ limit, offset = 0, search }: Page) {
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
             (array_agg(mv.id ORDER BY mfh.hash, mv.id))[1] AS "modelVersionId",
             (array_agg(mf.name ORDER BY mfh.hash, mv.id))[1] AS "fileName",
             (array_agg(mf."sizeKB" ORDER BY mfh.hash, mv.id))[1] AS "fileSizeKB"
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
    ),
    pg AS (
    SELECT c."modelId", c."modelName", c."userId", u.username, c.status, c.hash, c."createdAt",
           c."modelVersionId", c."fileName", c."fileSizeKB",
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
      -- Any seed on the hash, not only the one the LATERAL reports (the lowest minorModelId), or
      -- searching another flagged model on that hash misses the row.
      AND ${searchPredicate(
        search,
        {
          modelId: 'c.modelId',
          modelName: 'c.modelName',
          userId: 'c.userId',
          username: 'u.username',
        },
        (id) => sql`EXISTS (
          SELECT 1 FROM minor_src s3
          WHERE s3.hash = c.hash AND s3."userId" <> c."userId"
            AND (s3."minorModelId" = ${id} OR s3."userId" = ${id})
        )`
      )}
    ORDER BY c."modelId"
    LIMIT ${limit + 1} OFFSET ${offset}
    )
    -- The page is cut first (pg), so the per-model LATERALs are bounded by the limit.
    SELECT pg.*, m.type::text AS "modelType", m."createdAt" AS "modelCreatedAt",
           v."baseModel", COALESCE(v."trainedWords", '{}') AS "trainedWords",
           COALESCE(v."trainedWordCount", 0) AS "trainedWordCount",
           COALESCE(t.tags, '{}') AS tags, COALESCE(t."tagCount", 0) AS "tagCount",
           COALESCE(ci.images, '[]'::jsonb) AS "coverImages",
           COALESCE(up."otherFlaggedModels", 0) AS "otherFlaggedModels",
           jsonb_build_object(
             'approved', COALESCE(ap.approved, 0), 'rejected', COALESCE(ap.rejected, 0),
             'void', COALESCE(ap.void, 0), 'pending', COALESCE(ap.pending, 0)
           ) AS "pastAppeals"
    FROM pg
    JOIN "Model" m ON m.id = pg."modelId"
    ${modelFactsJoin}
    ${coverImagesJoin}
    ${uploaderFlagsJoin}
    ${pastAppealsJoin(sql``)}
    ORDER BY pg."modelId"
  `.execute(dbRead);

  // The extra row is how "there is another page" is known without a second count query.
  return { items: rows.rows.slice(0, limit), hasMore: rows.rows.length > limit };
}

export type AppealCoverImage = { id: number; url: string; nsfwLevel: number };

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
  poi: boolean;
  textScanFlags: unknown;
  latestScan: LatestScan | null;
  flaggedAt: Date | null;
  flagSource: string | null;
  flagConfirmedFrom: string | null;
  prevNsfw: boolean | null;
  prevGalleryLevel: number | null;
  modelType: string;
  modelCreatedAt: Date;
  baseModel: string | null;
  trainedWords: string[];
  trainedWordCount: number;
  tags: string[];
  tagCount: number;
  coverImages: AppealCoverImage[];
  flaggedByUsername: string | null;
  flaggedByAt: Date | null;
  otherFlaggedModels: number;
  pastAppeals: { approved: number; rejected: number; void: number; pending: number };
  /** This appeal's place among the uploader's model appeals this calendar year, counting it. */
  appealNthThisYear: number;
  /** The Flagged tab lists this model too (a hash flag in its window, a held re-detection or an open
   *  text-scan flag), so ruling there and here touch the same flag. */
  alsoInFlagged: boolean;
  scanRows: ScanRows;
};

export type AppealQuery = Page & { filters?: AppealFilters };

const APPEAL_TRAINED_WORDS_CAP = 8;
const APPEAL_TAGS_CAP = 12;
const APPEAL_COVER_COUNT = 4;

/** The model's first few images, joined to a CTE named `pg` that carries "modelId" and "userId".
 *  Shared by every queue that shows a model's pictures, so they load the same way. */
const coverImagesJoin = sql`
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
           jsonb_build_object('id', c.id, 'url', c.url, 'nsfwLevel', c."nsfwLevel")
           ORDER BY c.unpublished, c."versionIndex" ASC NULLS LAST, c."postId",
                    c."imageIndex" ASC NULLS LAST, c.id
         ) AS images
  FROM (
    -- Unpublishing a model clears its posts' publishedAt, so filtering on it would show an
    -- unpublished or draft model with no images at all.
    SELECT i.id, i.url, i."nsfwLevel", p."publishedAt" IS NULL AS unpublished, mv.index AS "versionIndex",
           p.id AS "postId", i.index AS "imageIndex"
    FROM "ModelVersion" mv
    JOIN "Post" p ON p."modelVersionId" = mv.id
    JOIN "Image" i ON i."postId" = p.id
    WHERE mv."modelId" = pg."modelId"
      AND p."userId" = pg."userId"
      AND i.type::text = 'image'
    ORDER BY unpublished, mv.index ASC NULLS LAST, p.id ASC, i.index ASC NULLS LAST, i.id ASC
    LIMIT ${sql.raw(String(APPEAL_COVER_COUNT))}
  ) c
) ci ON TRUE
`;

/** The version a model's facts describe: the newest published one, else the newest. Needs `mv`. */
const latestVersionOrder = sql`(mv.status::text = 'Published') DESC, mv."createdAt" DESC, mv.id DESC`;

/** Latest version's base model and trigger words, plus the model's tags, joined to a CTE named `pg`
 *  with "modelId". Bounded by the page, like the cover images. */
const modelFactsJoin = sql`
LEFT JOIN LATERAL (
  SELECT mv."baseModel", mv."trainedWords"[1:${sql.raw(
    String(APPEAL_TRAINED_WORDS_CAP)
  )}] AS "trainedWords", cardinality(mv."trainedWords") AS "trainedWordCount"
  FROM "ModelVersion" mv
  WHERE mv."modelId" = pg."modelId"
  ORDER BY ${latestVersionOrder}
  LIMIT 1
) v ON TRUE
LEFT JOIN LATERAL (
  SELECT array_agg(x.name ORDER BY x.name) AS tags,
         (SELECT count(*)::int FROM "TagsOnModels" tc WHERE tc."modelId" = pg."modelId") AS "tagCount"
  FROM (
    SELECT tg.name::text AS name
    FROM "TagsOnModels" tom
    JOIN "Tag" tg ON tg.id = tom."tagId"
    WHERE tom."modelId" = pg."modelId"
    ORDER BY tg.name
    LIMIT ${sql.raw(String(APPEAL_TAGS_CAP))}
  ) x
) t ON TRUE
`;

/** How many other flagged models the uploader has; `pg` carries "userId" and "modelId". */
const uploaderFlagsJoin = sql`
LEFT JOIN LATERAL (
  SELECT count(*)::int AS "otherFlaggedModels"
  FROM "Model" o
  WHERE o."userId" = pg."userId" AND o.id <> pg."modelId" AND (o.minor OR o.poi)
) up ON TRUE
`;

/** The uploader's appeals by outcome; `exclude` drops the appeal being viewed, if any. */
const pastAppealsJoin = (exclude: RawBuilder<unknown>) => sql`
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE pa.status::text = 'Approved')::int AS approved,
         count(*) FILTER (WHERE pa.status::text = 'Rejected')::int AS rejected,
         count(*) FILTER (WHERE pa.status::text = 'Void')::int AS void,
         count(*) FILTER (WHERE pa.status::text = 'Pending')::int AS pending
  FROM "Appeal" pa
  WHERE pa."userId" = pg."userId" AND pa."entityType" = 'Model' AND pa.category IS NULL ${exclude}
) ap ON TRUE
`;

const TEXT_SCAN_SEARCH_ENTITY_TYPE = 'Model:search';

type ScanRowAlias = 'sm' | 'ss';
const SCAN_ROW_SOURCE: Record<ScanRowAlias, LatestScanSource> = { sm: 'main', ss: 'web search' };

const scanLabelValue = (row: ScanRowAlias, label: FlagLabel) =>
  sql`${sql.raw(row)}.result->'labels'->${sql.lit(label)}`;

const scanCarriesLabel = (row: ScanRowAlias, label: FlagLabel) =>
  sql`COALESCE(jsonb_typeof(${scanLabelValue(row, label)}) = 'object', FALSE)`;

/** `EntityModeration.updatedAt` is a UTC `timestamp WITHOUT time zone`. jsonb renders it with no offset
 *  and the TIMESTAMP parser that appends Z only reaches plain columns, so it is formatted here. No
 *  `AT TIME ZONE 'UTC'`: on this type that converts to timestamptz, which `to_char` then renders in the
 *  session zone (unlike `revertedLastAt`, whose input is already timestamptz). */
const scanUpdatedAtSql = (row: ScanRowAlias) =>
  sql`to_char(${sql.raw(row)}."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const scanLabelSql = (row: ScanRowAlias, label: FlagLabel) => {
  const value = scanLabelValue(row, label);
  const r = sql.raw(row);
  return sql`jsonb_build_object(
    'detected', CASE WHEN jsonb_typeof(${value}->'detected') = 'boolean'
                     THEN (${value}->>'detected')::boolean END,
    'reason', ${value}->>'reason', 'source', ${sql.lit(SCAN_ROW_SOURCE[row])},
    'status', ${r}.status::text,
    'updatedAt', ${scanUpdatedAtSql(row)}
  )`;
};

/** Per label: the newest Succeeded row that carries it, else whichever row carries it. Once web
 *  search is active the main pass is submitted without poi/minor, but its row keeps the poi/minor it
 *  last carried, and search mode can fall back to off, so neither row wins outright. */
const latestScanLabelSql = (label: FlagLabel) => {
  const rank = (row: ScanRowAlias) =>
    sql`(${sql.raw(row)}.status::text = 'Succeeded', ${sql.raw(row)}."updatedAt")`;
  return sql`CASE
    WHEN ${scanCarriesLabel('ss', label)}
     AND (NOT ${scanCarriesLabel('sm', label)} OR ${rank('ss')} >= ${rank('sm')})
      THEN ${scanLabelSql('ss', label)}
    WHEN ${scanCarriesLabel('sm', label)} THEN ${scanLabelSql('sm', label)}
  END`;
};

const scanRowSql = (row: ScanRowAlias) => {
  const r = sql.raw(row);
  return sql`CASE WHEN ${r}."entityId" IS NOT NULL THEN jsonb_build_object(
    'workflowId', ${r}."workflowId", 'textHash', ${r}.result->>'textHash', 'status', ${r}.status::text,
    'updatedAt', ${scanUpdatedAtSql(row)}
  ) END`;
};

/** Both text-scan rows as they stand: which pass raised a flag (its workflow) and whether the text
 *  has changed since (its hash) are read from these. Needs `sm` and `ss` joined. */
const scanRowsSql = sql`jsonb_build_object('main', ${scanRowSql('sm')}, 'search', ${scanRowSql(
  'ss'
)})`;

/** A text-scan real-person flag sets `poi` and `meta.textScanFlags.poi` but writes no snapshot, so the
 *  snapshot source alone would file it under "No flag record". One expression feeds the list predicate,
 *  the facet groups and the returned row. */
const flagSourceSql = sql`COALESCE(
  m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'source',
  CASE WHEN m.poi AND m.meta->'textScanFlags' ? 'poi' THEN ${SNAPSHOT_SOURCE['text-scan']} END
)`;

const appealSourcePredicate = (source: AppealSource) => {
  if (source === 'all') return sql`TRUE`;
  if (source === 'none')
    return sql`(${flagSourceSql} IS NULL OR ${flagSourceSql} NOT IN (${sql.join(
      Object.values(SNAPSHOT_SOURCE)
    )}))`;
  return sql`${flagSourceSql} = ${SNAPSHOT_SOURCE[source]}`;
};

const appealFlagPredicate = (flag: AppealFlag) =>
  flag === 'minor'
    ? sql`m.minor`
    : flag === 'poi'
    ? sql`m.poi`
    : flag === 'unflagged'
    ? sql`(NOT m.minor AND NOT m.poi)`
    : sql`TRUE`;

const flaggedAtSql = sql`(m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz`;

/** Open appeals against a minor or real-person flag. Deliberately NOT the auto-flagged tab narrowed by
 *  an appeal: that tab bounds itself to `source='auto'` inside `AUTO_FLAG_REVIEW_WINDOW_DAYS` and drops
 *  accepted flags, so an appeal against a moderator's own Set-as-Minor, or against a flag that has
 *  since aged out, would surface nowhere. An appeal is a human asking for review, which outranks every
 *  one of those bounds.
 *
 *  No gate on the model still being minor either: reverting from tab 2 leaves the appeal Pending, and
 *  hiding it here would strand it with nowhere left to close it. `minor` is returned so the row can
 *  show that state instead.
 *
 *  The page is cut first (CTE) so the per-model LATERALs are bounded by limit. */
export async function getMinorFlagAppealsForReview({
  limit,
  offset = 0,
  search,
  filters = DEFAULT_APPEAL_FILTERS,
}: AppealQuery) {
  const inner =
    filters.sort === 'newest'
      ? sql`a."createdAt" DESC, a.id DESC`
      : filters.sort === 'flagged'
      ? sql`${flaggedAtSql} DESC NULLS LAST, a."createdAt", a.id`
      : sql`a."createdAt", a.id`;
  const outer =
    filters.sort === 'newest'
      ? sql`pg."appealCreatedAt" DESC, pg."appealId" DESC`
      : filters.sort === 'flagged'
      ? sql`pg."flaggedAt" DESC NULLS LAST, pg."appealCreatedAt", pg."appealId"`
      : sql`pg."appealCreatedAt", pg."appealId"`;

  const rows = await sql<MinorFlagAppealRow>`
    WITH pg AS (
      SELECT a.id AS "appealId", a."appealMessage", a."createdAt" AS "appealCreatedAt",
             m.id AS "modelId", m.name AS "modelName", m."userId", u.username,
             m.status::text AS status, m.minor, m.poi, m.type::text AS "modelType",
             m."createdAt" AS "modelCreatedAt",
             m.meta->'textScanFlags' AS "textScanFlags",
             ${flaggedAtSql} AS "flaggedAt",
             ${flagSourceSql} AS "flagSource",
             -- A moderator affirming an auto-flag rewrites source to 'manual', so this is the only
             -- surviving record that a hash match started it.
             m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'confirmedFrom' AS "flagConfirmedFrom",
             (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevNsfw')::boolean AS "prevNsfw",
             (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevGalleryLevel')::int AS "prevGalleryLevel"
      FROM "Appeal" a
      JOIN "Model" m ON m.id = a."entityId"
      LEFT JOIN "User" u ON u.id = m."userId"
      WHERE a."entityType" = 'Model' AND a.category IS NULL
        -- Cast rather than bind the enum: the value goes over as text and Postgres has no
        -- AppealStatus = text operator.
        AND a.status::text = 'Pending'
        AND ${appealSourcePredicate(filters.source)}
        AND ${appealFlagPredicate(filters.flag)}
        AND ${searchPredicate(search, userRefs)}
      ORDER BY ${inner}
      LIMIT ${limit + 1} OFFSET ${offset}
    )
    SELECT pg.*,
           v."baseModel", COALESCE(v."trainedWords", '{}') AS "trainedWords",
           COALESCE(v."trainedWordCount", 0) AS "trainedWordCount",
           COALESCE(t.tags, '{}') AS tags, COALESCE(t."tagCount", 0) AS "tagCount",
           COALESCE(ci.images, '[]'::jsonb) AS "coverImages",
           fb.username AS "flaggedByUsername", fb."createdAt" AS "flaggedByAt",
           COALESCE(up."otherFlaggedModels", 0) AS "otherFlaggedModels",
           CASE WHEN ls.poi IS NULL AND ls.minor IS NULL THEN NULL
                ELSE jsonb_build_object('poi', ls.poi, 'minor', ls.minor) END AS "latestScan",
           ${scanRowsSql} AS "scanRows",
           jsonb_build_object(
             'approved', COALESCE(ap.approved, 0), 'rejected', COALESCE(ap.rejected, 0),
             'void', COALESCE(ap.void, 0), 'pending', COALESCE(ap.pending, 0)
           ) AS "pastAppeals",
           ya.nth AS "appealNthThisYear",
           ${inFlaggedQueueSql} AS "alsoInFlagged"
    FROM pg
    ${modelFactsJoin}
    ${coverImagesJoin}
    LEFT JOIN LATERAL (
      SELECT ma."createdAt", su.username
      FROM "ModActivity" ma
      LEFT JOIN "User" su ON su.id = ma."userId"
      WHERE pg."flagSource" = ${SNAPSHOT_SOURCE.moderator}
        AND ma."entityType" = 'model'
        AND ma."entityId" = pg."modelId"
        AND ma.activity = 'setMinor'
      ORDER BY ma."createdAt" DESC
      LIMIT 1
    ) fb ON TRUE
    ${uploaderFlagsJoin}
    LEFT JOIN "EntityModeration" sm
      ON sm."entityType" = 'Model' AND sm."entityId" = pg."modelId"
    LEFT JOIN "EntityModeration" ss
      ON ss."entityType" = ${TEXT_SCAN_SEARCH_ENTITY_TYPE} AND ss."entityId" = pg."modelId"
    LEFT JOIN LATERAL (
      SELECT ${latestScanLabelSql('poi')} AS poi, ${latestScanLabelSql('minor')} AS minor
    ) ls ON TRUE
    ${pastAppealsJoin(sql`AND pa.id <> pg."appealId"`)}
    LEFT JOIN LATERAL (
      SELECT count(*)::int + 1 AS nth
      FROM "Appeal" ya
      WHERE ya."userId" = pg."userId" AND ya."entityType" = 'Model' AND ya.category IS NULL
        AND ya."createdAt" >= date_trunc('year', pg."appealCreatedAt")
        AND (ya."createdAt", ya.id) < (pg."appealCreatedAt", pg."appealId")
    ) ya ON TRUE
    ORDER BY ${outer}
  `.execute(dbRead);

  return { items: rows.rows.slice(0, limit), hasMore: rows.rows.length > limit };
}

/** Cross-tabbed on source and flag state so both chip rows come from one scan. */
export async function getMinorFlagAppealGroups({ search }: { search?: MinorSearch }) {
  const rows = await sql<AppealGroup>`
    SELECT ${flagSourceSql} AS source, m.minor, m.poi, count(*)::int AS count
    FROM "Appeal" a
    JOIN "Model" m ON m.id = a."entityId"
    ${joinsUploader(search) ? sql`LEFT JOIN "User" u ON u.id = m."userId"` : sql``}
    WHERE a."entityType" = 'Model' AND a.category IS NULL
      AND a.status::text = 'Pending'
      AND ${searchPredicate(search, userRefs)}
    GROUP BY 1, 2, 3
  `.execute(dbRead);
  return rows.rows;
}

export type { FlaggedSource };

/** One waiting flag on a Flagged row: a label and what raised it. A model carries at most one per
 *  label and source; text-scan auto-flags with no ruling join as a third `source`. */
export type FlaggedFlagItem = {
  label: FlagLabel;
  source: FlaggedSource;
  /** The detected text a ruling is bound to; null for hash flags. */
  textHash: string | null;
  /** ISO timestamp (from jsonb), or null when the entry carries none. */
  flaggedAt: string | null;
  /** Hash flags only: days until the review window closes and the flag is presumed correct. */
  daysLeft: number | null;
  redetected: RedetectionView | null;
  /** Text-scan flags only: the flag entry as the scan wrote it (reason, names, hash). */
  scanEntry: TextScanFlagView | null;
  granted: PriorClearView | null;
  grantedByUsername: string | null;
  rulings: FlagRulingView[] | null;
  prevNsfw: boolean | null;
  prevGalleryLevel: number | null;
};

/** One model waiting in the Flagged tab, with every flag on it that is waiting (minor first). */
export type FlaggedRow = {
  /** The model id: one row per model. */
  key: string;
  modelId: number;
  modelName: string;
  userId: number;
  username: string | null;
  status: string;
  minor: boolean;
  poi: boolean;
  flags: FlaggedFlagItem[];
  /** The sort key: the oldest flag's time (newest flag's under newest-first). */
  flaggedAt: Date | null;
  /** Rows with a text-scan flag only: what the latest scan rows say now. */
  latestScan: LatestScan | null;
  /** Rows with a text-scan or re-detected flag: both scan rows, for provenance and "unchanged since
   *  flag". */
  scanRows: ScanRows;
  hasPendingAppeal: boolean;
  modelType: string;
  modelCreatedAt: Date;
  baseModel: string | null;
  trainedWords: string[];
  trainedWordCount: number;
  tags: string[];
  tagCount: number;
  coverImages: AppealCoverImage[];
  otherFlaggedModels: number;
  pastAppeals: { approved: number; rejected: number; void: number; pending: number };
};

export type FlaggedQuery = Page & { filters?: FlaggedFilters };

/** MUST match the predicate of the partial index `Model_textScanRedetected_idx` (see its migration)
 *  character for character. The sidebar count runs on every page load, so a mismatch turns each
 *  load into a seq scan of "Model". Every query over the queue repeats this fragment. */
const redetectedIndexPredicate = sql`
  (m.meta->'textScanFlags'->'minor' ? 'redetected'
    OR m.meta->'textScanFlags'->'poi' ? 'redetected')
`;

/** A row per label: the same model can wait on `minor` and `poi` separately. */
const redetectedLabelsJoin = sql`
  CROSS JOIN LATERAL (VALUES
    ('minor', m.meta->'textScanFlags'->'minor'),
    ('poi', m.meta->'textScanFlags'->'poi')
  ) AS l(label, entry)
`;

const redetectedAt = sql`(l.entry->'redetected'->>'at')::timestamptz`;

/** Every branch selects the same columns, in this order, so they can be UNIONed and grouped. Only the
 *  model id and the flag's own facts: the model's columns are joined once after grouping, so no
 *  difference between branches can split a model into two rows. */
const hashBranch = (search: MinorSearch | undefined) => sql`
  SELECT m.id AS "modelId",
         'minor'::text AS label, 'hash'::text AS source, NULL::text AS "textHash",
         (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz AS "flaggedAt",
         NULL::jsonb AS redetected, NULL::jsonb AS "scanEntry",
         NULL::jsonb AS granted, NULL::text AS "grantedByUsername",
         m.meta->'textScanFlags'->'minor'->'rulings' AS rulings,
         (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevNsfw')::boolean AS "prevNsfw",
         (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevGalleryLevel')::int AS "prevGalleryLevel"
  FROM "Model" m
  LEFT JOIN "User" u ON u.id = m."userId"
  WHERE ${hashFlaggedPredicate(search)}
    AND ${searchPredicate(search, userRefs)}
`;

const redetectedBranch = (search: MinorSearch | undefined, flag: FlaggedFlag) => sql`
  SELECT m.id AS "modelId",
         l.label::text AS label, 'redetected'::text AS source,
         l.entry->'redetected'->>'textHash' AS "textHash",
         ${redetectedAt} AS "flaggedAt",
         l.entry->'redetected' AS redetected, NULL::jsonb AS "scanEntry",
         l.entry->'appealGranted' AS granted,
         gu.username AS "grantedByUsername", l.entry->'rulings' AS rulings,
         NULL::boolean AS "prevNsfw", NULL::int AS "prevGalleryLevel"
  FROM "Model" m
  ${redetectedLabelsJoin}
  LEFT JOIN "User" u ON u.id = m."userId"
  LEFT JOIN "User" gu ON gu.id = CASE
    WHEN jsonb_typeof(l.entry->'appealGranted'->'by') = 'number'
      THEN (l.entry->'appealGranted'->>'by')::int
  END
  WHERE ${redetectedIndexPredicate}
    AND l.entry ? 'redetected'
    AND ${flag === 'all' ? sql`TRUE` : sql`l.label = ${flag}`}
    AND ${searchPredicate(search, userRefs)}
`;

/** The predicate of the partial index `Model_textScanFlagged_idx` (hand-applied migration
 *  `20261101130000_model_text_scan_flagged_idx`), repeated in every query so the index is used. Until
 *  it is applied in prod these queries scan "Model", and the bounded sidebar count absorbs that. */
const textScanIndexPredicate = sql`
  (m.meta->'textScanFlags'->'minor' ? 'workflowId'
    OR m.meta->'textScanFlags'->'poi' ? 'workflowId')
`;

/** A text-scan flag is waiting for a ruling while its entry has a workflow and no ruling stub, and
 *  the live column still carries it. A minor flag the hash sweep owns (any snapshot, whatever its
 *  window or source) is ruled through the hash branch and never relisted here, even after it was
 *  confirmed, accepted or aged out. The poi label has no hash twin. */
const textScanFlaggedPredicate = sql`
  ${textScanIndexPredicate}
  AND l.entry ? 'workflowId'
  AND NOT l.entry ? 'appealUpheld'
  AND NOT l.entry ? 'appealGranted'
  AND NOT l.entry ? 'redetected'
  AND CASE WHEN l.label = 'minor' THEN m.minor ELSE m.poi END
  AND NOT (l.label = 'minor' AND m.meta ? ${MINOR_FLAG_SNAPSHOT_KEY})
`;

/** The Flagged tab lists the model under any of its three sources; the appeals rows say so. Takes a
 *  model id from `pg`, so it is evaluated once per page row. */
const inFlaggedQueueSql = sql`EXISTS (
  SELECT 1 FROM "Model" m
  ${redetectedLabelsJoin}
  WHERE m.id = pg."modelId"
    AND (
      (l.label = 'minor' AND ${hashFlaggedPredicate()})
      OR (${redetectedIndexPredicate} AND l.entry ? 'redetected')
      OR (${textScanFlaggedPredicate})
    )
)`;

const textScanBranch = (search: MinorSearch | undefined, flag: FlaggedFlag) => sql`
  SELECT m.id AS "modelId",
         l.label::text AS label, 'text-scan'::text AS source,
         l.entry->>'textHash' AS "textHash",
         (l.entry->>'at')::timestamptz AS "flaggedAt",
         NULL::jsonb AS redetected, l.entry AS "scanEntry",
         NULL::jsonb AS granted, NULL::text AS "grantedByUsername",
         l.entry->'rulings' AS rulings,
         NULL::boolean AS "prevNsfw", NULL::int AS "prevGalleryLevel"
  FROM "Model" m
  ${redetectedLabelsJoin}
  LEFT JOIN "User" u ON u.id = m."userId"
  WHERE ${textScanFlaggedPredicate}
    AND ${flag === 'all' ? sql`TRUE` : sql`l.label = ${flag}`}
    AND ${searchPredicate(search, userRefs)}
`;

/** Which branches a filter selects. Hash flags are minor flags, so a real-person filter excludes them. */
const flaggedBranches = ({ source, flag }: Pick<FlaggedFilters, 'source' | 'flag'>) => ({
  hash: (source === 'all' || source === 'hash') && flag !== 'poi',
  redetected: source === 'all' || source === 'redetected',
  textScan: source === 'all' || source === 'text-scan',
});

const msPerDay = 86_400_000;
export const reviewDaysLeft = (flaggedAt: Date | string, now = Date.now()) =>
  Math.max(
    0,
    Math.ceil(AUTO_FLAG_REVIEW_WINDOW_DAYS - (now - new Date(flaggedAt).getTime()) / msPerDay)
  );

const flaggedBranchList = (search: MinorSearch | undefined, filters: FlaggedFilters) => {
  const use = flaggedBranches(filters);
  return [
    ...(use.hash ? [hashBranch(search)] : []),
    ...(use.redetected ? [redetectedBranch(search, filters.flag)] : []),
    ...(use.textScan ? [textScanBranch(search, filters.flag)] : []),
  ];
};

type FlaggedSqlRow = Omit<FlaggedRow, 'key' | 'flags'> & {
  flags: Omit<FlaggedFlagItem, 'daysLeft'>[];
};

/** Hash auto-flags in their review window, text-scan auto-flags and held re-detections, merged in
 *  SQL and grouped per model, so one query pages, sorts and counts models: a model flagged minor and
 *  real person is one row carrying both flags. Oldest flag first by default so nothing starves (newest
 *  first sorts on the newest flag); a model with no timestamp sorts last either way. A filter narrows
 *  the flags a row carries, not just which rows show.
 *
 *  The page is cut first (CTE) so the per-model LATERALs are bounded by limit. */
export async function getFlaggedModels({
  limit,
  offset = 0,
  search,
  filters = DEFAULT_FLAGGED_FILTERS,
}: FlaggedQuery) {
  const branches = flaggedBranchList(search, filters);
  if (!branches.length) return { items: [] as FlaggedRow[], hasMore: false };

  const newest = filters.sort === 'newest';
  const [sortAt, inner, outer] = newest
    ? [
        sql`max("flaggedAt")`,
        sql`"flaggedAt" DESC NULLS LAST, "modelId" DESC`,
        sql`pg."flaggedAt" DESC NULLS LAST, pg."modelId" DESC`,
      ]
    : [
        sql`min("flaggedAt")`,
        sql`"flaggedAt" NULLS LAST, "modelId"`,
        sql`pg."flaggedAt" NULLS LAST, pg."modelId"`,
      ];

  const rows = await sql<FlaggedSqlRow>`
    WITH grouped AS (
      SELECT "modelId", ${sortAt} AS "flaggedAt",
             jsonb_agg(jsonb_build_object(
               'label', label, 'source', source, 'textHash', "textHash", 'flaggedAt', "flaggedAt",
               'redetected', redetected, 'scanEntry', "scanEntry", 'granted', granted,
               'grantedByUsername', "grantedByUsername", 'rulings', rulings,
               'prevNsfw', "prevNsfw", 'prevGalleryLevel', "prevGalleryLevel"
             ) ORDER BY label, source) AS flags,
             bool_or(source <> 'hash') AS "hasScanFlag",
             bool_or(source = 'text-scan') AS "hasTextScanFlag"
      FROM (${sql.join(branches, sql` UNION ALL `)}) flagged
      GROUP BY "modelId"
      ORDER BY ${inner}
      LIMIT ${limit + 1} OFFSET ${offset}
    ),
    pg AS (
      SELECT g.*, m.name AS "modelName", m."userId", u.username, m.status::text AS status,
             m.minor, m.poi, m.type::text AS "modelType", m."createdAt" AS "modelCreatedAt"
      FROM grouped g
      JOIN "Model" m ON m.id = g."modelId"
      LEFT JOIN "User" u ON u.id = m."userId"
    )
    SELECT pg."modelId", pg."modelName", pg."userId", pg.username, pg.status, pg.minor, pg.poi,
           pg."modelType", pg."modelCreatedAt", pg."flaggedAt", pg.flags,
           -- Any label: must match the main app's rule in resolveTextScanRedetection, which refuses
           -- a ruling while the model has a Pending appeal.
           EXISTS (
             SELECT 1 FROM "Appeal" a
             WHERE a."entityType" = 'Model' AND a."entityId" = pg."modelId"
               AND a.status::text = 'Pending' AND a.category IS NULL
           ) AS "hasPendingAppeal",
           v."baseModel", COALESCE(v."trainedWords", '{}') AS "trainedWords",
           COALESCE(v."trainedWordCount", 0) AS "trainedWordCount",
           COALESCE(t.tags, '{}') AS tags, COALESCE(t."tagCount", 0) AS "tagCount",
           COALESCE(ci.images, '[]'::jsonb) AS "coverImages",
           COALESCE(up."otherFlaggedModels", 0) AS "otherFlaggedModels",
           jsonb_build_object(
             'approved', COALESCE(ap.approved, 0), 'rejected', COALESCE(ap.rejected, 0),
             'void', COALESCE(ap.void, 0), 'pending', COALESCE(ap.pending, 0)
           ) AS "pastAppeals",
           CASE WHEN pg."hasTextScanFlag"
                THEN jsonb_build_object('poi', ls.poi, 'minor', ls.minor) END AS "latestScan",
           CASE WHEN pg."hasScanFlag" THEN ${scanRowsSql} END AS "scanRows"
    FROM pg
    LEFT JOIN "EntityModeration" sm
      ON pg."hasScanFlag" AND sm."entityType" = 'Model' AND sm."entityId" = pg."modelId"
    LEFT JOIN "EntityModeration" ss
      ON pg."hasScanFlag" AND ss."entityType" = ${TEXT_SCAN_SEARCH_ENTITY_TYPE}
         AND ss."entityId" = pg."modelId"
    LEFT JOIN LATERAL (
      SELECT ${latestScanLabelSql('poi')} AS poi, ${latestScanLabelSql('minor')} AS minor
    ) ls ON TRUE
    ${modelFactsJoin}
    ${coverImagesJoin}
    ${uploaderFlagsJoin}
    ${pastAppealsJoin(sql``)}
    ORDER BY ${outer}
  `.execute(dbRead);

  const now = Date.now();
  const items: FlaggedRow[] = rows.rows.slice(0, limit).map((row) => ({
    ...row,
    key: String(row.modelId),
    flags: row.flags.map((flag) => ({
      ...flag,
      daysLeft:
        flag.source === 'hash' && flag.flaggedAt ? reviewDaysLeft(flag.flaggedAt, now) : null,
    })),
  }));
  return { items, hasMore: rows.rows.length > limit };
}

/** Hash auto-flags still waiting on a human. Cheap enough for the sidebar, unlike the Pending count. */
export async function getAutoFlaggedCount({ search }: { search?: MinorSearch } = {}) {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count
    FROM "Model" m
    ${joinsUploader(search) ? sql`LEFT JOIN "User" u ON u.id = m."userId"` : sql``}
    WHERE ${hashFlaggedPredicate(search)}
      AND ${searchPredicate(search, userRefs)}
  `.execute(dbRead);
  return result.rows[0]?.count ?? 0;
}

/** The Flagged list's total in models, over the same branches as `getFlaggedModels`: a model with
 *  two waiting flags counts once. With no arguments it is the whole queue, which the tab badge shows. */
export async function getFlaggedCount({
  search,
  source = 'all',
  flag = 'all',
}: { search?: MinorSearch } & Partial<Pick<FlaggedFilters, 'source' | 'flag'>> = {}) {
  const branches = flaggedBranchList(search, { ...DEFAULT_FLAGGED_FILTERS, source, flag });
  if (!branches.length) return 0;
  const result = await sql<{ count: number }>`
    SELECT count(DISTINCT "modelId")::int AS count
    FROM (${sql.join(branches, sql` UNION ALL `)}) flagged
  `.execute(dbRead);
  return result.rows[0]?.count ?? 0;
}

/** Text-scan flags waiting on a ruling, both labels. No index serves the predicate, so this scans
 *  "Model"; callers on a hot path bound it. */
export async function getTextScanFlaggedCount({
  search,
  flag = 'all',
}: { search?: MinorSearch; flag?: FlaggedFlag } = {}) {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count
    FROM "Model" m
    ${redetectedLabelsJoin}
    ${joinsUploader(search) ? sql`LEFT JOIN "User" u ON u.id = m."userId"` : sql``}
    WHERE ${textScanFlaggedPredicate}
      AND ${flag === 'all' ? sql`TRUE` : sql`l.label = ${flag}`}
      AND ${searchPredicate(search, userRefs)}
  `.execute(dbRead);
  return result.rows[0]?.count ?? 0;
}

/** Labels waiting on a ruling. With no arguments it is the whole queue, which the tab badge shows;
 *  given the list's search and flag filter it is that list's total, over the same predicates. */
export async function getRedetectedCount({
  search,
  flag = 'all',
}: { search?: MinorSearch; flag?: FlaggedFlag } = {}) {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count
    FROM "Model" m
    ${redetectedLabelsJoin}
    ${joinsUploader(search) ? sql`LEFT JOIN "User" u ON u.id = m."userId"` : sql``}
    WHERE ${redetectedIndexPredicate}
      AND l.entry ? 'redetected'
      AND ${flag === 'all' ? sql`TRUE` : sql`l.label = ${flag}`}
      AND ${searchPredicate(search, userRefs)}
  `.execute(dbRead);
  return result.rows[0]?.count ?? 0;
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
  /** This model's file carrying the shared hash. */
  fileName: string;
  fileSizeKB: number;
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
           mfh.hash, mv.id AS "modelVersionId", mf.name AS "fileName", mf."sizeKB" AS "fileSizeKB"
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

/** The Auto-flagged tab's and the appeal panel's detail. Two queries rather than one join, so the second is
 *  the exact same `getMinorHashMatchDetail` the review queue expands with — the panels stay identical
 *  by construction rather than by being kept in step.
 *
 *  The detail query runs even with no seed: a manual Set-as-Minor has no hash match by definition, and
 *  that is most of what the appeals page reviews. Short-circuiting left those panels with no cover, no
 *  upload date and "0 models" for the uploader. */
export async function getAutoFlaggedMinorDetail({ modelId }: { modelId: number }) {
  const match = await getAutoFlaggedMinorMatch({ modelId });
  const detail = await getMinorHashMatchDetail({
    modelId,
    minorModelId: match?.minorModelId ?? null,
  });
  return { match, detail };
}

export type MinorQueueCounts = { pending: number };

/**
 * The File matches count. Cached rather than computed per request, because it costs ~10s on its own: it
 * has to build the same seed set and candidate CTE the queue does, then count the whole population
 * instead of one page of it.
 */
const counts = createCache({ name: 'minor-queue-counts:v2', fetch: fetchCounts, ttlSeconds: 300 });

export function getMinorQueueCounts(): Promise<MinorQueueCounts> {
  return counts.get({});
}

/** Every verdict moves a model out of one of these populations, and five minutes is a long time to
 *  label a tab with a number the moderator has already changed. */
export function bustMinorQueueCounts(): Promise<void> {
  return counts.bust({});
}

async function fetchCounts(): Promise<MinorQueueCounts> {
  const pending = await sql<{ count: number }>`
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
  `.execute(dbRead);

  return { pending: Number(pending.rows[0]?.count ?? 0) };
}

type ModelFactsRow = Omit<ModelFlagDetail, 'strikes' | 'notes' | 'promptVersions'> & {
  userId: number;
};

/** ISO 8601 date with optional time and offset, field ranges checked. Not `pg_input_is_valid`
 *  (Postgres 16+ only); an impossible day such as Feb 31 still passes and would still throw. */
const ISO_TIMESTAMP_PATTERN =
  '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])([T ]([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?)?(Z|[+-]\\d{2}(:?\\d{2})?)?$';

/** A meta timestamp read from OTHER models: one malformed value must not fail the whole statement, so
 *  anything that is not an ISO string reads as null. */
const safeTimestamptz = (value: RawBuilder<unknown>) =>
  sql`CASE WHEN ${value} ~ ${sql.lit(ISO_TIMESTAMP_PATTERN)} THEN (${value})::timestamptz END`;

/** A flag lifted on a model: a hash flag rolled back (`minorHashCleared`) or a text-scan flag cleared
 *  on appeal or by a moderator (`appealGranted`). `o` is the model. */
const revertedAtSql = sql`GREATEST(
  ${safeTimestamptz(sql`o.meta->${MINOR_HASH_CLEARED_KEY}->>'at'`)},
  ${safeTimestamptz(sql`o.meta->'textScanFlags'->'minor'->'appealGranted'->>'at'`)},
  ${safeTimestamptz(sql`o.meta->'textScanFlags'->'poi'->'appealGranted'->>'at'`)}
)`;
const revertedSql = sql`(
  o.meta ? ${MINOR_HASH_CLEARED_KEY}
  OR o.meta->'textScanFlags'->'minor' ? 'appealGranted'
  OR o.meta->'textScanFlags'->'poi' ? 'appealGranted'
)`;

/** Strikes in force: Active, not voided and not past expiry (the status lags until the expiry job
 *  sweeps it). Not `strikeCountsByUserIds`, which counts every strike ever issued, voided and expired
 *  included, plus legacy moderator-database rows that carry no status at all. */
async function activeStrikeCount(userId: number) {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count
    FROM "UserStrike" s
    WHERE s."userId" = ${userId}
      AND s.status::text = 'Active'
      AND s."voidedAt" IS NULL
      AND s."expiresAt" > now()
  `.execute(dbRead);
  return result.rows[0]?.count ?? 0;
}

/**
 * What only the open detail pane shows, for one model: fetched on selection rather than joined into
 * the list, so a 50-row page does not pay for facts 49 rows never show. One statement on the main
 * database, then the uploader's active strikes and their notes (moderator database), which degrade to
 * null rather than failing the pane.
 */
export async function getModelFlagDetail({
  modelId,
  promptIds = [],
}: {
  modelId: number;
  /** TextScanPrompt ids from the flag entries on screen, to number within their key. */
  promptIds?: readonly number[];
}): Promise<ModelFlagDetail | null> {
  const [facts, prompts] = await Promise.all([
    sql<ModelFactsRow>`
      SELECT m."userId", m."nsfwLevel",
             'nsfwLevel' = ANY(m."lockedProperties") AS "ratingLocked",
             u."createdAt" AS "uploaderJoinedAt",
             mm."downloadCount" AS downloads, mm."generationCount" AS generations,
             v."versionCount", v."latestPublishedAt",
             CASE WHEN f.name IS NOT NULL THEN jsonb_build_object(
               'name', f.name, 'sizeKB', f."sizeKB", 'scansOk', f."scansOk", 'otherFiles', f."otherFiles"
             ) END AS "mainFile",
             -- The same set the cover images come from: images on the owner's posts of the model.
             (SELECT count(*)::int
              FROM "ModelVersion" pv
              JOIN "Post" p ON p."modelVersionId" = pv.id AND p."userId" = m."userId"
              JOIN "Image" i ON i."postId" = p.id AND i.type::text = 'image'
              WHERE pv."modelId" = m.id) AS "previewCount",
             (SELECT count(*)::int
              FROM "ModelReport" mr
              JOIN "Report" r ON r.id = mr."reportId"
              WHERE mr."modelId" = m.id AND r.status::text IN ('Pending', 'Processing')) AS "openReports",
             up."uploaderPublished", up."uploaderModUnpublished",
             jsonb_build_object('count', up."revertedCount", 'lastAt', up."revertedLastAt") AS "flagsReverted"
      FROM "Model" m
      LEFT JOIN "User" u ON u.id = m."userId"
      LEFT JOIN "ModelMetric" mm ON mm."modelId" = m.id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS "versionCount",
               max(mv."publishedAt") FILTER (WHERE mv.status::text = 'Published') AS "latestPublishedAt"
        FROM "ModelVersion" mv WHERE mv."modelId" = m.id
      ) v ON TRUE
      -- The latest version as the model facts pick it, then its model file over any other file.
      LEFT JOIN LATERAL (
        SELECT mv.id FROM "ModelVersion" mv
        WHERE mv."modelId" = m.id
        ORDER BY ${latestVersionOrder}
        LIMIT 1
      ) lv ON TRUE
      LEFT JOIN LATERAL (
        SELECT mf.name, mf."sizeKB",
               (mf."pickleScanResult"::text = 'Success' AND mf."virusScanResult"::text = 'Success') AS "scansOk",
               (count(*) OVER ())::int - 1 AS "otherFiles"
        FROM "ModelFile" mf
        WHERE mf."modelVersionId" = lv.id AND mf."replacedAt" IS NULL
        ORDER BY (mf.type = 'Model') DESC, mf.id
        LIMIT 1
      ) f ON TRUE
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE o.status::text = 'Published')::int AS "uploaderPublished",
               count(*) FILTER (WHERE o.status::text = 'UnpublishedViolation')::int AS "uploaderModUnpublished",
               count(*) FILTER (WHERE o.id <> m.id AND ${revertedSql})::int AS "revertedCount",
               to_char(max(${revertedAtSql}) FILTER (WHERE o.id <> m.id) AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "revertedLastAt"
        FROM "Model" o WHERE o."userId" = m."userId"
      ) up ON TRUE
      WHERE m.id = ${modelId}
    `.execute(dbRead),
    promptIds.length
      ? sql<{ id: number; version: number }>`
          SELECT p.id,
                 (SELECT count(*)::int FROM "TextScanPrompt" q WHERE q.key = p.key AND q.id <= p.id) AS version
          FROM "TextScanPrompt" p
          WHERE p.id IN (${sql.join(promptIds)})
        `.execute(dbRead)
      : { rows: [] },
  ]);

  const row = facts.rows[0];
  if (!row) return null;
  const { userId, ...model } = row;

  const [strikes, notes] = await Promise.all([
    activeStrikeCount(userId).catch(() => null),
    getUserNotes(userId, null).then(
      (list) => list.length,
      () => null
    ),
  ]);

  return {
    ...model,
    strikes,
    notes,
    promptVersions: Object.fromEntries(prompts.rows.map((p) => [p.id, p.version])),
  };
}
