import { sql, type RawBuilder } from '@civitai/db/kysely';
import { createCache } from './cache';
import { dbRead } from './db';
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
  PriorClearView,
  RedetectionView,
} from '$lib/minor-flags/text-scan-verdicts';

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

/** The scan hook's flags still inside the review window and not yet affirmed by a human. */
const hashFlaggedPredicate = sql`
  m.meta ? ${MINOR_FLAG_SNAPSHOT_KEY}
  AND m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'source' = 'auto'
  AND NOT ${humanConfirmedPredicate}
  AND NOT (m.meta ? ${MINOR_HASH_ACCEPTED_KEY})
  AND (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz > ${reviewWindowCutoff}
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

export type MinorSearch = { modelOrUserId: number } | { username: string };

const searchPredicate = (
  search: MinorSearch | undefined,
  refs: { modelId: string; userId: string; username: string },
  orSeed?: (id: number) => RawBuilder<unknown>
) => {
  if (!search) return sql`TRUE`;
  if ('username' in search)
    return sql`lower(${sql.ref(refs.username)}) = lower(${search.username})`;
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
      -- Any seed on the hash, not only the one the LATERAL reports (the lowest minorModelId), or
      -- searching another flagged model on that hash misses the row.
      AND ${searchPredicate(
        search,
        { modelId: 'c.modelId', userId: 'c.userId', username: 'u.username' },
        (id) => sql`EXISTS (
          SELECT 1 FROM minor_src s3
          WHERE s3.hash = c.hash AND s3."userId" <> c."userId"
            AND (s3."minorModelId" = ${id} OR s3."userId" = ${id})
        )`
      )}
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
export async function getAutoFlaggedMinorModels({ limit, offset = 0, search }: Page) {
  const rows = await sql<AutoFlaggedMinorModel>`
    SELECT m.id AS "modelId", m.name AS "modelName", m."userId", u.username,
           m.status::text AS status,
           (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz AS "flaggedAt",
           (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevNsfw')::boolean AS "prevNsfw",
           (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevGalleryLevel')::int AS "prevGalleryLevel"
    FROM "Model" m
    LEFT JOIN "User" u ON u.id = m."userId"
    WHERE ${hashFlaggedPredicate}
      AND ${searchPredicate(search, {
        modelId: 'm.id',
        userId: 'm.userId',
        username: 'u.username',
      })}
    ORDER BY (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz DESC, m.id DESC
    LIMIT ${limit + 1} OFFSET ${offset}
  `.execute(dbRead);

  return { items: rows.rows.slice(0, limit), hasMore: rows.rows.length > limit };
}

export type AppealCoverImage = { id: number; url: string };

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
           jsonb_build_object('id', c.id, 'url', c.url)
           ORDER BY c.unpublished, c."versionIndex" ASC NULLS LAST, c."postId",
                    c."imageIndex" ASC NULLS LAST, c.id
         ) AS images
  FROM (
    -- Unpublishing a model clears its posts' publishedAt, so filtering on it would show an
    -- unpublished or draft model with no images at all.
    SELECT i.id, i.url, p."publishedAt" IS NULL AS unpublished, mv.index AS "versionIndex",
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

/** Latest version's base model and trigger words, plus the model's tags, joined to a CTE named `pg`
 *  with "modelId". Bounded by the page, like the cover images. */
const modelFactsJoin = sql`
LEFT JOIN LATERAL (
  SELECT mv."baseModel", mv."trainedWords"[1:${sql.raw(
    String(APPEAL_TRAINED_WORDS_CAP)
  )}] AS "trainedWords", cardinality(mv."trainedWords") AS "trainedWordCount"
  FROM "ModelVersion" mv
  WHERE mv."modelId" = pg."modelId"
  ORDER BY (mv.status::text = 'Published') DESC, mv."createdAt" DESC, mv.id DESC
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
  WHERE pa."userId" = pg."userId" AND pa."entityType" = 'Model' ${exclude}
) ap ON TRUE
`;

const TEXT_SCAN_SEARCH_ENTITY_TYPE = 'Model:search';

type ScanRowAlias = 'sm' | 'ss';
const SCAN_ROW_SOURCE: Record<ScanRowAlias, LatestScanSource> = { sm: 'main', ss: 'web search' };

const scanLabelValue = (row: ScanRowAlias, label: FlagLabel) =>
  sql`${sql.raw(row)}.result->'labels'->${sql.lit(label)}`;

const scanCarriesLabel = (row: ScanRowAlias, label: FlagLabel) =>
  sql`COALESCE(jsonb_typeof(${scanLabelValue(row, label)}) = 'object', FALSE)`;

// `updatedAt` is a UTC timestamp without time zone. jsonb renders it with no offset and the
// TIMESTAMP parser that appends Z only reaches plain columns, so it is formatted as UTC here.
const scanLabelSql = (row: ScanRowAlias, label: FlagLabel) => {
  const value = scanLabelValue(row, label);
  const r = sql.raw(row);
  return sql`jsonb_build_object(
    'detected', CASE WHEN jsonb_typeof(${value}->'detected') = 'boolean'
                     THEN (${value}->>'detected')::boolean END,
    'reason', ${value}->>'reason', 'source', ${sql.lit(SCAN_ROW_SOURCE[row])},
    'status', ${r}.status::text,
    'updatedAt', to_char(${r}."updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
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
      WHERE a."entityType" = 'Model'
        -- Cast rather than bind the enum: the value goes over as text and Postgres has no
        -- AppealStatus = text operator.
        AND a.status::text = 'Pending'
        AND ${appealSourcePredicate(filters.source)}
        AND ${appealFlagPredicate(filters.flag)}
        AND ${searchPredicate(search, {
          modelId: 'm.id',
          userId: 'm.userId',
          username: 'u.username',
        })}
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
           jsonb_build_object(
             'approved', COALESCE(ap.approved, 0), 'rejected', COALESCE(ap.rejected, 0),
             'void', COALESCE(ap.void, 0), 'pending', COALESCE(ap.pending, 0)
           ) AS "pastAppeals"
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
    ${search && 'username' in search ? sql`LEFT JOIN "User" u ON u.id = m."userId"` : sql``}
    WHERE a."entityType" = 'Model'
      AND a.status::text = 'Pending'
      AND ${searchPredicate(search, {
        modelId: 'm.id',
        userId: 'm.userId',
        username: 'u.username',
      })}
    GROUP BY 1, 2, 3
  `.execute(dbRead);
  return rows.rows;
}

export type FlaggedSource = 'hash' | 'redetected';

/** One waiting item of the Flagged tab, whatever raised it. A model can appear once per label and
 *  source, so the key is the triple. Text-scan auto-flags with no ruling join as a third `source`. */
export type FlaggedRow = {
  key: string;
  modelId: number;
  modelName: string;
  userId: number;
  username: string | null;
  status: string;
  minor: boolean;
  poi: boolean;
  label: FlagLabel;
  source: FlaggedSource;
  /** The detected text a re-detection ruling is bound to; null for hash flags. */
  textHash: string | null;
  flaggedAt: Date | null;
  /** Hash flags only: days until the review window closes and the flag is presumed correct. */
  daysLeft: number | null;
  redetected: RedetectionView | null;
  granted: PriorClearView | null;
  grantedByUsername: string | null;
  rulings: FlagRulingView[] | null;
  prevNsfw: boolean | null;
  prevGalleryLevel: number | null;
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

const userRefs = { modelId: 'm.id', userId: 'm.userId', username: 'u.username' };

/** Both branches select the same columns, in this order, so they can be UNIONed and paged once. */
const hashBranch = (search: MinorSearch | undefined) => sql`
  SELECT m.id AS "modelId", m.name AS "modelName", m."userId", u.username,
         m.status::text AS status, m.minor, m.poi,
         'minor'::text AS label, 'hash'::text AS source, NULL::text AS "textHash",
         m.type::text AS "modelType", m."createdAt" AS "modelCreatedAt",
         (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz AS "flaggedAt",
         NULL::jsonb AS redetected, NULL::jsonb AS granted, NULL::text AS "grantedByUsername",
         m.meta->'textScanFlags'->'minor'->'rulings' AS rulings,
         (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevNsfw')::boolean AS "prevNsfw",
         (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'prevGalleryLevel')::int AS "prevGalleryLevel"
  FROM "Model" m
  LEFT JOIN "User" u ON u.id = m."userId"
  WHERE ${hashFlaggedPredicate}
    AND ${searchPredicate(search, userRefs)}
`;

const redetectedBranch = (search: MinorSearch | undefined, flag: FlaggedFlag) => sql`
  SELECT m.id AS "modelId", m.name AS "modelName", m."userId", u.username,
         m.status::text AS status, m.minor, m.poi,
         l.label::text AS label, 'redetected'::text AS source,
         l.entry->'redetected'->>'textHash' AS "textHash",
         m.type::text AS "modelType", m."createdAt" AS "modelCreatedAt",
         ${redetectedAt} AS "flaggedAt",
         l.entry->'redetected' AS redetected, l.entry->'appealGranted' AS granted,
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

/** Which branches a filter selects. Hash flags are minor flags, so a real-person filter excludes them. */
const flaggedBranches = ({ source, flag }: Pick<FlaggedFilters, 'source' | 'flag'>) => ({
  hash: source !== 'redetected' && flag !== 'poi',
  redetected: source !== 'hash',
});

const msPerDay = 86_400_000;
export const reviewDaysLeft = (flaggedAt: Date | string, now = Date.now()) =>
  Math.max(
    0,
    Math.ceil(AUTO_FLAG_REVIEW_WINDOW_DAYS - (now - new Date(flaggedAt).getTime()) / msPerDay)
  );

/** Hash auto-flags in their review window and held re-detections, merged in SQL so one query pages,
 *  sorts and counts across both. Oldest flag first by default so nothing starves; an item with no
 *  timestamp sorts last either way.
 *
 *  The page is cut first (CTE) so the per-model LATERALs are bounded by limit. */
export async function getFlaggedModels({
  limit,
  offset = 0,
  search,
  filters = DEFAULT_FLAGGED_FILTERS,
}: FlaggedQuery) {
  const use = flaggedBranches(filters);
  const branches = [
    ...(use.hash ? [hashBranch(search)] : []),
    ...(use.redetected ? [redetectedBranch(search, filters.flag)] : []),
  ];
  if (!branches.length) return { items: [] as FlaggedRow[], hasMore: false };

  const [inner, outer] =
    filters.sort === 'newest'
      ? [
          sql`"flaggedAt" DESC NULLS LAST, "modelId" DESC, label, source`,
          sql`pg."flaggedAt" DESC NULLS LAST, pg."modelId" DESC, pg.label, pg.source`,
        ]
      : [
          sql`"flaggedAt" NULLS LAST, "modelId", label, source`,
          sql`pg."flaggedAt" NULLS LAST, pg."modelId", pg.label, pg.source`,
        ];

  const rows = await sql<Omit<FlaggedRow, 'key' | 'daysLeft'>>`
    WITH pg AS (
      SELECT * FROM (${sql.join(branches, sql` UNION ALL `)}) flagged
      ORDER BY ${inner}
      LIMIT ${limit + 1} OFFSET ${offset}
    )
    SELECT pg.*,
           -- Any label: must match the main app's rule in resolveTextScanRedetection, which refuses
           -- a ruling while the model has a Pending appeal.
           EXISTS (
             SELECT 1 FROM "Appeal" a
             WHERE a."entityType" = 'Model' AND a."entityId" = pg."modelId"
               AND a.status::text = 'Pending'
           ) AS "hasPendingAppeal",
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
    ${modelFactsJoin}
    ${coverImagesJoin}
    ${uploaderFlagsJoin}
    ${pastAppealsJoin(sql``)}
    ORDER BY ${outer}
  `.execute(dbRead);

  const now = Date.now();
  const items: FlaggedRow[] = rows.rows.slice(0, limit).map((row) => ({
    ...row,
    key: `${row.modelId}:${row.label}:${row.source}`,
    daysLeft: row.source === 'hash' && row.flaggedAt ? reviewDaysLeft(row.flaggedAt, now) : null,
  }));
  return { items, hasMore: rows.rows.length > limit };
}

/** Hash auto-flags still waiting on a human. Cheap enough for the sidebar, unlike the Pending count. */
export async function getAutoFlaggedCount({ search }: { search?: MinorSearch } = {}) {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count
    FROM "Model" m
    ${search && 'username' in search ? sql`LEFT JOIN "User" u ON u.id = m."userId"` : sql``}
    WHERE ${hashFlaggedPredicate}
      AND ${searchPredicate(search, userRefs)}
  `.execute(dbRead);
  return result.rows[0]?.count ?? 0;
}

/** The Flagged list's total, over the same predicates as `getFlaggedModels`. */
export async function getFlaggedCount({
  search,
  source = 'all',
  flag = 'all',
}: { search?: MinorSearch } & Partial<Pick<FlaggedFilters, 'source' | 'flag'>> = {}) {
  const use = flaggedBranches({ source, flag });
  const [hash, redetected] = await Promise.all([
    use.hash ? getAutoFlaggedCount({ search }) : 0,
    use.redetected ? getRedetectedCount({ search, flag }) : 0,
  ]);
  return hash + redetected;
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
    ${search && 'username' in search ? sql`LEFT JOIN "User" u ON u.id = m."userId"` : sql``}
    WHERE ${redetectedIndexPredicate}
      AND l.entry ? 'redetected'
      AND ${flag === 'all' ? sql`TRUE` : sql`l.label = ${flag}`}
      AND ${searchPredicate(search, {
        modelId: 'm.id',
        userId: 'm.userId',
        username: 'u.username',
      })}
  `.execute(dbRead);
  return result.rows[0]?.count ?? 0;
}

export type ModelMinorState = {
  modelId: number;
  modelName: string;
  userId: number;
  username: string | null;
  status: string;
  minor: boolean;
  minorLocked: boolean;
  flagSource: string | null;
  flagConfirmedFrom: string | null;
  flaggedAt: Date | null;
  clearedAt: Date | null;
  acceptedAt: Date | null;
};

/** Reaches a model no tab lists — e.g. a same-uploader auto-flag older than
 *  `AUTO_FLAG_REVIEW_WINDOW_DAYS` — so its Revert is still reachable. */
export async function getModelMinorState(modelId: number) {
  const result = await sql<ModelMinorState>`
    SELECT m.id AS "modelId", m.name AS "modelName", m."userId", u.username,
           m.status::text AS status, m.minor,
           'minor' = ANY(m."lockedProperties") AS "minorLocked",
           m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'source' AS "flagSource",
           m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'confirmedFrom' AS "flagConfirmedFrom",
           (m.meta->${MINOR_FLAG_SNAPSHOT_KEY}->>'at')::timestamptz AS "flaggedAt",
           (m.meta->${MINOR_HASH_CLEARED_KEY}->>'at')::timestamptz AS "clearedAt",
           (m.meta->${MINOR_HASH_ACCEPTED_KEY}->>'at')::timestamptz AS "acceptedAt"
    FROM "Model" m
    LEFT JOIN "User" u ON u.id = m."userId"
    WHERE m.id = ${modelId}
  `.execute(dbRead);

  return result.rows[0] ?? null;
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

export type MinorQueueCounts = { pending: number; auto: number };

/**
 * Tab counts. Client-fetched and cached rather than part of `load`, because the Pending count costs
 * ~10s on its own: it has to build the same seed set and candidate CTE the queue does, then count the
 * whole population instead of one page of it. Blocking every page render on that to label two tabs
 * is the trade the row queries already refuse.
 *
 * Both in one round trip, since a moderator reads them together and a tab labelled with a count
 * from a different moment is the thing worth avoiding.
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
    sql<{ auto: number }>`
      SELECT
        (SELECT count(*)::int FROM "Model" m
          WHERE ${hashFlaggedPredicate}
        ) AS auto
    `.execute(dbRead),
  ]);

  return {
    pending: Number(pending.rows[0]?.count ?? 0),
    auto: Number(rest.rows[0]?.auto ?? 0),
  };
}
