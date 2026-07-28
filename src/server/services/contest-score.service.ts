/**
 * Community-pick scoring for contest collections.
 *
 * Each entry (a CollectionItem carrying a modelId) is scored by counting DISTINCT
 * QUALIFIED USERS per signal inside the contest window, normalized within its
 * category, then weighted. Distinct-user counting IS the anti-cheat: one account
 * contributes at most 1 to any signal, so volume farming collapses to 1.
 *
 * Categories are separate contests — normalization and ranking never cross a
 * category boundary, so raw volume is never compared across them.
 *
 * Every count is computed IN the database. No user-id array ever crosses into
 * Node: the age gate becomes a `userId <= threshold` pushdown, and the (small)
 * disqualified set is pushed into each query as a literal id list.
 *
 * Weights and thresholds are NOT in this file and have no code default. They live
 * in `contestScoring:<collectionId>` (falling back to `contestScoring:default`);
 * this module fails loudly when neither row exists. They are recorded in every
 * snapshot and stripped from every response.
 */

import { Prisma } from '@prisma/client';
import pLimit from 'p-limit';
import * as z from 'zod';
import { CONTEST_SNAPSHOT_KEY_PREFIX, KEY_VALUE_KEYS } from '~/server/common/constants';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { dbKV } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { collectionMetadataSchema } from '~/server/schema/collection.schema';
import type {
  CreateContestSnapshotInput,
  GetCommunityScoreInput,
  GetContestCandidatesInput,
  ContestScoreSignal,
} from '~/server/schema/contest-score.schema';
import { contestScoreSignals } from '~/server/schema/contest-score.schema';
import { bustFetchThroughCache, fetchThroughCache } from '~/server/utils/cache-helpers';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { withSpan } from '~/server/utils/otel-helpers';
import { Availability, CollectionItemStatus, CollectionMode } from '~/shared/utils/prisma/enums';
import { hashifyObject } from '~/utils/string-helpers';

type Signal = ContestScoreSignal;

/**
 * Bumped whenever a change here could move a ranking. Recorded in every snapshot so
 * a disputed result can be traced to the code that produced it.
 */
export const CONTEST_SCORE_CODE_VERSION = 2;

/**
 * Comments and tips are deliberately unweighted: both are trivially launderable
 * (a tip can be sent back out of band).
 */
export const CONTEST_SIGNAL_SOURCES: Record<Signal, string> = {
  imageAuthors: 'Distinct authors of on-site images made with the model',
  reactors: 'Distinct users reacting to those images',
  downloaders: 'Distinct users downloading the model',
  generators: 'Distinct users generating with the model',
  collectors: 'Distinct users adding the model to another collection',
};

const MAX_ENTRIES = 1000;
const SCORE_CACHE_TTL = 60 * 15;
// Entities per ClickHouse call. Chunks are cut along ENTRY boundaries, never entity
// ones: uniqExact cannot be summed across chunks, so every entity belonging to an
// entry has to be counted in the same call.
const CH_ENTITY_CHUNK = 20000;
const CH_CONCURRENCY = 4;
const DEFAULT_STATUSES: CollectionItemStatus[] = [CollectionItemStatus.ACCEPTED];

/**
 * An error whose message is safe to show the caller — a misconfiguration or a bad
 * request, never a query failure. Everything else is logged and replaced with a
 * generic message, because the ClickHouse `$query` wrapper appends the generated
 * SQL (id lists included) to the errors it throws.
 */
export class ContestScoringError extends Error {}

function sanitizeError(collectionId: number, e: unknown): never {
  if (e instanceof ContestScoringError) throw throwBadRequestError(e.message);
  const error = e as Error;
  logToAxiom(
    { name: 'contest-score', type: 'error', collectionId, message: error?.message },
    'civitai-prod'
  ).catch(() => null);
  console.error('[contest-score] failed', collectionId, error?.message);
  throw new Error('Contest scoring failed. See server logs.');
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Structural validation only. A bound on a weight or a threshold discloses that
// value's range, so nothing here constrains magnitude.
const weightsSchema = z.object(
  Object.fromEntries(contestScoreSignals.map((s) => [s, z.number()])) as Record<Signal, z.ZodNumber>
);
const storedConfigSchema = z.object({
  version: z.number(),
  weights: weightsSchema,
  ageGateDays: z.number(),
  farmIp: z.object({ minPeers: z.number(), minEntries: z.number() }),
});

export type ContestScoringConfig = z.infer<typeof storedConfigSchema>;

const configKey = (suffix: number | 'default') => `${KEY_VALUE_KEYS.CONTEST_SCORING}:${suffix}`;

/**
 * Per-collection config with a global fallback. One shared row would let a later
 * edit retroactively change a finished contest's ranking.
 */
export async function getContestScoringConfig(collectionId: number): Promise<ContestScoringConfig> {
  const [specific, fallback] = await Promise.all([
    dbKV.get<unknown>(configKey(collectionId)),
    dbKV.get<unknown>(configKey('default')),
  ]);

  const stored = specific ?? fallback;
  if (!stored)
    throw new ContestScoringError(
      `Contest scoring is not configured: neither "${configKey(collectionId)}" nor "${configKey(
        'default'
      )}" exists in KeyValue. Weights and thresholds live only in the database — there is no code fallback.`
    );

  const parsed = storedConfigSchema.safeParse(stored);
  if (!parsed.success)
    throw new ContestScoringError(
      `The contest scoring config for collection ${collectionId} is malformed: ${parsed.error.message}`
    );

  return parsed.data;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

export type ResolvedWindow = {
  start: Date;
  end: Date;
  /** `end` clamped to now. A contest still running is scored up to this instant. */
  effectiveEnd: Date;
  /** True while the contest is still open — the run is a preview, not a result. */
  partial: boolean;
  ageCutoff: Date;
};

/**
 * Derived from the collection's own contest metadata, never defaulted. An absent
 * window silently becoming "all time" would switch the age gate off, which is the
 * worst way for this to fail.
 */
async function resolveWindow(
  collectionId: number,
  input: { start?: Date; end?: Date },
  config: ContestScoringConfig
): Promise<ResolvedWindow> {
  const collection = await dbRead.collection.findUnique({
    where: { id: collectionId },
    select: { id: true, mode: true, metadata: true },
  });
  if (!collection) throw new ContestScoringError(`Collection ${collectionId} not found`);
  if (collection.mode !== CollectionMode.Contest)
    throw new ContestScoringError(`Collection ${collectionId} is not a contest collection`);

  const parsed = collectionMetadataSchema.safeParse(collection.metadata ?? {});
  const metadata = parsed.success ? parsed.data : {};

  const start = input.start ?? metadata.submissionStartDate;
  const end = input.end ?? metadata.submissionEndDate ?? metadata.endsAt;
  if (!start)
    throw new ContestScoringError(
      `Collection ${collectionId} has no submissionStartDate and no explicit window start was given.`
    );
  if (!end)
    throw new ContestScoringError(
      `Collection ${collectionId} has neither submissionEndDate nor endsAt, and no explicit window end was given.`
    );

  // Always the contest's own start, never a narrowed display window — otherwise
  // zooming the view would drag the age gate along with it.
  const contestStart = metadata.submissionStartDate ?? start;
  const ageCutoff = new Date(contestStart.getTime() - config.ageGateDays * 24 * 60 * 60 * 1000);

  const now = new Date();
  const partial = end > now;

  return { start, end, effectiveEnd: partial ? now : end, partial, ageCutoff };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

type Gates = {
  /** An account with an id above this registered after the cutoff. */
  userIdThreshold: number;
  /**
   * Users wrongly caught by the id threshold: registered before the cutoff but
   * holding an id above it. Recorded so a snapshot can be audited.
   */
  ageGateBandUsers: number;
  disqualifiedIds: number[];
};

async function loadGates(window: ResolvedWindow): Promise<Gates> {
  // `User.id` is autoincrement but NOT strictly monotonic with `createdAt` — at
  // least one backdated system account exists. `max(id) WHERE createdAt <= cutoff`
  // would let that single row drag the threshold up and wave through every account
  // registered since. `min(id) WHERE createdAt > cutoff` minus one can only ever be
  // too strict, which is the safe direction for an anti-cheat gate.
  const [threshold] = await withSpan(
    'contest-score.age-threshold',
    () =>
      dbRead.$queryRaw<{ threshold: number; bandUsers: number }[]>`
      WITH t AS (
        SELECT COALESCE(
          (SELECT min(id) FROM "User" WHERE "createdAt" > ${window.ageCutoff}) - 1,
          (SELECT max(id) FROM "User")
        ) AS threshold
      )
      SELECT
        t.threshold::int AS "threshold",
        (
          SELECT count(*)::int FROM "User" u
          WHERE u."createdAt" <= ${window.ageCutoff} AND u.id > t.threshold
        ) AS "bandUsers"
      FROM t
    `
  );

  if (threshold?.bandUsers)
    console.warn(
      `[contest-score] age gate band holds ${threshold.bandUsers} user(s) registered before the cutoff but carrying an id above the threshold; they are disqualified.`
    );

  // Only accounts banned or deleted ON OR AFTER the window start can have engaged
  // during it — every signal here requires an authenticated action and a banned or
  // deleted account cannot perform one. That turns a 1.35M-row set into a few
  // thousand, small enough to push into ClickHouse. Contest bans are unconditional
  // (a scoring sanction, not an access one) and number in the dozens.
  const banned = await withSpan(
    'contest-score.banned',
    () =>
      dbRead.$queryRaw<{ id: number }[]>`
      SELECT u.id
      FROM "User" u
      WHERE u.id <= ${threshold.threshold}
        AND (
          u."bannedAt" >= ${window.start}
          OR u."deletedAt" >= ${window.start}
          OR u.meta ->> 'contestBanDetails' IS NOT NULL
        )
    `
  );

  const excluded = await withSpan('contest-score.excluded-users', () =>
    clickhouse!.$query<{ userId: number }>(`
      SELECT userId FROM metricExcludedUsers FINAL WHERE active = 1
    `)
  );

  const disqualifiedIds = [
    ...new Set([...banned.map((b) => b.id), ...excluded.map((e) => Number(e.userId))]),
  ].sort((a, b) => a - b);

  return {
    userIdThreshold: threshold.threshold,
    ageGateBandUsers: threshold.bandUsers,
    disqualifiedIds,
  };
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

type EntryRow = {
  collectionItemId: number;
  modelId: number;
  modelName: string;
  creatorId: number;
  creatorUsername: string | null;
  addedById: number | null;
  tagId: number | null;
  tagName: string | null;
  status: string;
  modelStatus: string;
  modelDeleted: boolean;
  modelAvailability: string;
};

type EntryImage = {
  id: number;
  url: string;
  nsfwLevel: number;
  type: string;
  width: number | null;
  height: number | null;
};

/** Every id reaching raw SQL passes through here, so nothing downstream has to trust a caller. */
function intList(values: number[]) {
  for (const value of values)
    if (!Number.isInteger(value)) throw new ContestScoringError('Expected integer identifiers');
  return values.join(',');
}

function ineligibilityReason(entry: EntryRow) {
  if (entry.modelDeleted) return 'Model deleted';
  if (entry.modelStatus !== 'Published') return `Model ${entry.modelStatus.toLowerCase()}`;
  if (entry.modelAvailability === Availability.Private) return 'Model is private';
  return null;
}

type WindowInput = {
  collectionId: number;
  start?: Date;
  end?: Date;
  tagIds?: number[];
  statuses?: CollectionItemStatus[];
};

async function loadEntries(input: WindowInput) {
  const { collectionId, tagIds } = input;
  const statuses = input.statuses ?? DEFAULT_STATUSES;

  const items = await withSpan(
    'contest-score.entries',
    () =>
      dbRead.$queryRaw<EntryRow[]>`
      SELECT
        ci.id                     AS "collectionItemId",
        ci."modelId"              AS "modelId",
        m.name                    AS "modelName",
        m."userId"                AS "creatorId",
        u.username                AS "creatorUsername",
        ci."addedById"            AS "addedById",
        ci."tagId"                AS "tagId",
        t.name                    AS "tagName",
        ci.status::text           AS "status",
        m.status::text            AS "modelStatus",
        m."deletedAt" IS NOT NULL AS "modelDeleted",
        m.availability::text      AS "modelAvailability"
      FROM "CollectionItem" ci
      JOIN "Model" m ON m.id = ci."modelId"
      LEFT JOIN "User" u ON u.id = m."userId"
      LEFT JOIN "Tag" t ON t.id = ci."tagId"
      WHERE ci."collectionId" = ${collectionId}
        AND ci."modelId" IS NOT NULL
        AND ci.status = ANY(ARRAY[${Prisma.join(statuses)}]::"CollectionItemStatus"[])
        ${tagIds?.length ? Prisma.sql`AND ci."tagId" IN (${Prisma.join(tagIds)})` : Prisma.empty}
      ORDER BY ci.id
      LIMIT ${MAX_ENTRIES + 1}
    `
  );

  return { entries: items.slice(0, MAX_ENTRIES), truncated: items.length > MAX_ENTRIES };
}

/** One representative image per model — the creator's own showcase post, in their order. */
async function loadEntryImages(modelIds: number[]) {
  const images = new Map<number, EntryImage>();
  if (!modelIds.length) return images;

  const rows = await withSpan(
    'contest-score.entry-images',
    () =>
      dbRead.$queryRaw<({ modelId: number } & EntryImage)[]>`
      SELECT DISTINCT ON (mv."modelId")
        mv."modelId"  AS "modelId",
        i.id          AS "id",
        i.url         AS "url",
        i."nsfwLevel" AS "nsfwLevel",
        i.type::text  AS "type",
        i.width       AS "width",
        i.height      AS "height"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      JOIN "Post" p ON p."modelVersionId" = mv.id AND p."userId" = m."userId"
      JOIN "Image" i ON i."postId" = p.id
      WHERE mv."modelId" IN (${Prisma.join(modelIds)})
        AND p."publishedAt" IS NOT NULL
        AND p."publishedAt" <= NOW()
        AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
      ORDER BY mv."modelId", mv."index", p.id, i."index"
    `
  );
  for (const { modelId, ...image } of rows) images.set(modelId, image);

  return images;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

type SignalCount = { collectionItemId: number; rawUsers: number; qualifiedUsers: number };

/**
 * (entity, entry) pairs for the ClickHouse joins. Deliberately many-to-many in both
 * directions: one image can credit several entered models (stacked LoRAs), and one
 * model can be entered more than once (two categories, a resubmission,
 * maxItemsPerUser > 1). Collapsing either direction silently zeroes an entry.
 */
type EntryPair = { entityId: number; entryId: number; creatorId: number; addedById: number };

/**
 * A ClickHouse-side lookup table built from a tuple literal. `values()` would read
 * better but is not available on every deployment; arrayJoin over a tuple array is.
 */
function chPairTable(pairs: EntryPair[]) {
  const tuples = pairs
    .map((p) => `(${intList([p.entityId, p.entryId, p.creatorId, p.addedById])})`)
    .join(',');
  return `
    SELECT
      toUInt64(p.1) AS entityId,
      toUInt64(p.2) AS entryId,
      toUInt64(p.3) AS creatorId,
      toUInt64(p.4) AS addedById
    FROM (SELECT arrayJoin([${tuples}]) AS p)
  `;
}

const chDateTime = (d: Date) => `toDateTime('${d.toISOString().slice(0, 19).replace('T', ' ')}')`;

/**
 * Counts distinct users per ENTRY inside ClickHouse. `source` projects `userId` and
 * `entityId`; the qualification gates are applied there too, so only two integers
 * per entry come back.
 */
function chCountQuery({
  source,
  pairs,
  gates,
}: {
  source: (entityIds: string) => string;
  pairs: EntryPair[];
  gates: Gates;
}) {
  const disqualified = gates.disqualifiedIds.length ? intList(gates.disqualifiedIds) : '0';
  const entityIds = intList([...new Set(pairs.map((p) => p.entityId))]);

  return `
    SELECT
      p.entryId AS entryId,
      uniqExact(s.userId) AS rawUsers,
      uniqExactIf(
        s.userId,
        s.userId <= ${gates.userIdThreshold}
          AND s.userId != p.creatorId
          AND (p.addedById = 0 OR s.userId != p.addedById)
          AND s.userId NOT IN (${disqualified})
      ) AS qualifiedUsers
    FROM (${source(entityIds)}) AS s
    INNER JOIN (${chPairTable(pairs)}) AS p ON s.entityId = p.entityId
    GROUP BY entryId
  `;
}

/**
 * Splits pairs into calls, cutting only between entries, and runs them with bounded
 * concurrency so a large contest cannot open an unbounded fan of CH queries.
 */
async function runChCounts(
  name: string,
  pairs: EntryPair[],
  gates: Gates,
  source: (entityIds: string) => string
): Promise<SignalCount[]> {
  if (!pairs.length) return [];

  const byEntry = new Map<number, EntryPair[]>();
  for (const pair of pairs) {
    const existing = byEntry.get(pair.entryId);
    if (existing) existing.push(pair);
    else byEntry.set(pair.entryId, [pair]);
  }

  const chunks: EntryPair[][] = [];
  let current: EntryPair[] = [];
  for (const group of byEntry.values()) {
    if (current.length && current.length + group.length > CH_ENTITY_CHUNK) {
      chunks.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length) chunks.push(current);

  return withSpan(
    `contest-score.${name}`,
    { pairs: pairs.length, chunks: chunks.length },
    async () => {
      const limit = pLimit(CH_CONCURRENCY);
      const results = await Promise.all(
        chunks.map((chunk) =>
          limit(() =>
            clickhouse!.$query<{ entryId: number; rawUsers: number; qualifiedUsers: number }>(
              chCountQuery({ source, pairs: chunk, gates })
            )
          )
        )
      );
      return results.flat().map((row) => ({
        collectionItemId: Number(row.entryId),
        rawUsers: Number(row.rawUsers),
        qualifiedUsers: Number(row.qualifiedUsers),
      }));
    }
  );
}

/** The entries as a Postgres lookup table, keyed by collectionItemId. */
function pgEntryTable(entries: EntryRow[]) {
  const values = entries
    .map(
      (e) =>
        `(${intList([e.collectionItemId, e.modelId, e.creatorId])},${
          e.addedById === null ? 'NULL' : intList([e.addedById])
        })`
    )
    .join(',');
  return Prisma.raw(`(VALUES ${values}) AS e("entryId", "modelId", "creatorId", "addedById")`);
}

/** The qualification gate, identical across every signal. */
function pgQualified(userColumn: string, gates: Gates) {
  const disqualified = gates.disqualifiedIds.length ? intList(gates.disqualifiedIds) : '-1';
  return Prisma.raw(`
    ${userColumn} <> e."creatorId"
    AND (e."addedById" IS NULL OR ${userColumn} <> e."addedById")
    AND ${userColumn} <= ${gates.userIdThreshold}
    AND NOT (${userColumn} = ANY(ARRAY[${disqualified}]::int[]))
  `);
}

/**
 * The entries' on-site images, windowed on PUBLICATION. Publication is the
 * contest-meaningful event — an already-existing model can be entered, so filtering
 * on image creation would credit or drop the wrong work. Scheduled posts carry a
 * future `publishedAt` and are visible to nobody, hence the `<= NOW()`.
 */
async function loadImagePairs(entries: EntryRow[], window: ResolvedWindow) {
  return withSpan(
    'contest-score.image-pairs',
    () =>
      dbRead.$queryRaw<{ entryId: number; imageId: number }[]>`
      SELECT DISTINCT e."entryId" AS "entryId", i.id AS "imageId"
      FROM ${pgEntryTable(entries)}
      JOIN "ModelVersion" mv ON mv."modelId" = e."modelId"
      JOIN "ImageResourceNew" ir ON ir."modelVersionId" = mv.id
      JOIN "Image" i ON i.id = ir."imageId"
      JOIN "Post" p ON p.id = i."postId"
      WHERE p."publishedAt" IS NOT NULL
        AND p."publishedAt" <= NOW()
        AND p."publishedAt" >= ${window.start}
        AND p."publishedAt" < ${window.effectiveEnd}
        AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
    `
  );
}

async function countImageAuthors(entries: EntryRow[], window: ResolvedWindow, gates: Gates) {
  return withSpan(
    'contest-score.image-authors',
    () =>
      dbRead.$queryRaw<SignalCount[]>`
      SELECT
        e."entryId"                     AS "collectionItemId",
        count(DISTINCT i."userId")::int AS "rawUsers",
        count(DISTINCT i."userId") FILTER (WHERE ${pgQualified('i."userId"', gates)})::int
                                        AS "qualifiedUsers"
      FROM ${pgEntryTable(entries)}
      JOIN "ModelVersion" mv ON mv."modelId" = e."modelId"
      JOIN "ImageResourceNew" ir ON ir."modelVersionId" = mv.id
      JOIN "Image" i ON i.id = ir."imageId"
      JOIN "Post" p ON p.id = i."postId"
      WHERE p."publishedAt" IS NOT NULL
        AND p."publishedAt" <= NOW()
        AND p."publishedAt" >= ${window.start}
        AND p."publishedAt" < ${window.effectiveEnd}
        AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
      GROUP BY e."entryId"
    `
  );
}

async function countCollectors(
  entries: EntryRow[],
  window: ResolvedWindow,
  gates: Gates,
  collectionId: number
) {
  return withSpan(
    'contest-score.collectors',
    () =>
      dbRead.$queryRaw<SignalCount[]>`
      SELECT
        e."entryId"                         AS "collectionItemId",
        count(DISTINCT ci."addedById")::int AS "rawUsers",
        count(DISTINCT ci."addedById") FILTER (WHERE ${pgQualified('ci."addedById"', gates)})::int
                                            AS "qualifiedUsers"
      FROM ${pgEntryTable(entries)}
      JOIN "CollectionItem" ci ON ci."modelId" = e."modelId"
      WHERE ci."collectionId" <> ${collectionId}
        AND ci."addedById" IS NOT NULL
        AND ci."createdAt" >= ${window.start}
        AND ci."createdAt" < ${window.effectiveEnd}
      GROUP BY e."entryId"
    `
  );
}

async function loadVersionPairs(entries: EntryRow[]) {
  const versions = await dbRead.$queryRaw<{ id: number; modelId: number }[]>`
    SELECT id, "modelId" FROM "ModelVersion"
    WHERE "modelId" IN (${Prisma.join(entries.map((e) => e.modelId))})
  `;

  const byModel = new Map<number, EntryRow[]>();
  for (const entry of entries) {
    const existing = byModel.get(entry.modelId);
    if (existing) existing.push(entry);
    else byModel.set(entry.modelId, [entry]);
  }

  const pairs: EntryPair[] = [];
  for (const version of versions)
    for (const entry of byModel.get(version.modelId) ?? [])
      pairs.push({
        entityId: version.id,
        entryId: entry.collectionItemId,
        creatorId: entry.creatorId,
        addedById: entry.addedById ?? 0,
      });

  return pairs;
}

function modelPairs(entries: EntryRow[]): EntryPair[] {
  return entries.map((entry) => ({
    entityId: entry.modelId,
    entryId: entry.collectionItemId,
    creatorId: entry.creatorId,
    addedById: entry.addedById ?? 0,
  }));
}

function toImagePairs(rows: { entryId: number; imageId: number }[], entries: EntryRow[]) {
  const byEntry = new Map(entries.map((e) => [e.collectionItemId, e]));
  const pairs: EntryPair[] = [];
  for (const row of rows) {
    const entry = byEntry.get(Number(row.entryId));
    if (!entry) continue;
    pairs.push({
      entityId: Number(row.imageId),
      entryId: entry.collectionItemId,
      creatorId: entry.creatorId,
      addedById: entry.addedById ?? 0,
    });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type ContestScoreEntry = {
  /** Null when the entry is ineligible, or when its whole category is tied at zero. */
  rank: number | null;
  collectionItemId: number;
  modelId: number;
  modelName: string;
  creatorId: number;
  creatorUsername: string | null;
  status: string;
  eligible: boolean;
  ineligibleReason: string | null;
  image: EntryImage | null;
  // No `normalized` here: alongside `score`, five normalized values and five scores
  // solve for the five weights. The UI never rendered it.
  signals: Record<Signal, { raw: number; qualified: number }>;
  rawTotal: number;
  qualifiedTotal: number;
  disqualifiedShare: number;
  score: number;
};

export type ContestScoreCategory = {
  tagId: number | null;
  tagName: string | null;
  entryCount: number;
  eligibleCount: number;
  /** A lone entrant normalizes to 1.0 on every non-zero signal — not a comparable score. */
  soloEntry: boolean;
  /** Nothing in this category scored: ranks are withheld rather than invented. */
  tied: boolean;
  entries: ContestScoreEntry[];
};

export type ContestCommunityScore = {
  collectionId: number;
  generatedAt: string;
  window: { start: string; end: string; effectiveEnd: string };
  partial: boolean;
  statuses: CollectionItemStatus[];
  entryCount: number;
  truncated: boolean;
  signalSources: Record<Signal, string>;
  categories: ContestScoreCategory[];
};

function requireClickhouse() {
  if (!clickhouse)
    throw new ContestScoringError('ClickHouse is not configured in this environment');
  return clickhouse;
}

function emptySignals() {
  return Object.fromEntries(
    contestScoreSignals.map((s) => [s, { raw: 0, qualified: 0 }])
  ) as ContestScoreEntry['signals'];
}

async function computeCommunityScore(input: WindowInput): Promise<ContestCommunityScore> {
  requireClickhouse();
  const config = await getContestScoringConfig(input.collectionId);
  const window = await resolveWindow(input.collectionId, input, config);
  const statuses = input.statuses ?? DEFAULT_STATUSES;

  const base = {
    collectionId: input.collectionId,
    generatedAt: new Date().toISOString(),
    window: {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      effectiveEnd: window.effectiveEnd.toISOString(),
    },
    partial: window.partial,
    statuses,
    signalSources: CONTEST_SIGNAL_SOURCES,
  };

  const { entries, truncated } = await loadEntries(input);
  if (!entries.length) return { ...base, entryCount: 0, truncated, categories: [] };

  const gates = await loadGates(window);

  const [imageAuthors, collectors, imageRows, versionPairs, images] = await Promise.all([
    countImageAuthors(entries, window, gates),
    countCollectors(entries, window, gates, input.collectionId),
    loadImagePairs(entries, window),
    loadVersionPairs(entries),
    loadEntryImages(entries.map((e) => e.modelId)),
  ]);

  const [reactors, downloaders, generators] = await Promise.all([
    runChCounts(
      'reactors',
      toImagePairs(imageRows, entries),
      gates,
      (ids) => `
        SELECT userId, entityId
        FROM reactions
        WHERE type = 'Image_Create'
          AND entityId IN (${ids})
          AND time >= ${chDateTime(window.start)} AND time < ${chDateTime(window.effectiveEnd)}
          AND userId != 0
      `
    ),
    runChCounts(
      'downloaders',
      modelPairs(entries),
      gates,
      (ids) => `
        SELECT userId, modelId AS entityId
        FROM modelVersionEvents
        WHERE type = 'Download'
          AND modelId IN (${ids})
          AND time >= ${chDateTime(window.start)} AND time < ${chDateTime(window.effectiveEnd)}
          AND userId != 0
      `
    ),
    // Straight off orchestration.jobs, NOT default.daily_user_resource: that view
    // only ingests jobType IN ('TextToImage','TextToImageV2','Comfy'), so every
    // newer engine (ComfyImageGen, AnimaComfy, StableDiffusionCpp, …) is missing
    // from it and whole ecosystems read as zero generations.
    runChCounts(
      'generators',
      versionPairs,
      gates,
      (ids) => `
        SELECT userId, resource AS entityId
        FROM orchestration.jobs
        ARRAY JOIN resourcesUsed AS resource
        WHERE resource IN (${ids})
          AND createdAt >= ${chDateTime(window.start)}
          AND createdAt < ${chDateTime(window.effectiveEnd)}
          AND userId != 0
      `
    ),
  ]);

  const counts = new Map<number, ContestScoreEntry['signals']>(
    entries.map((e) => [e.collectionItemId, emptySignals()])
  );
  const apply = (signal: Signal, rows: SignalCount[]) => {
    for (const row of rows) {
      const bucket = counts.get(Number(row.collectionItemId));
      if (!bucket) continue;
      bucket[signal] = { raw: Number(row.rawUsers), qualified: Number(row.qualifiedUsers) };
    }
  };
  apply('imageAuthors', imageAuthors);
  apply('collectors', collectors);
  apply('reactors', reactors);
  apply('downloaders', downloaders);
  apply('generators', generators);

  const scored = entries.map((entry) => {
    const signals = counts.get(entry.collectionItemId) ?? emptySignals();
    const rawTotal = contestScoreSignals.reduce((sum, s) => sum + signals[s].raw, 0);
    const qualifiedTotal = contestScoreSignals.reduce((sum, s) => sum + signals[s].qualified, 0);
    const reason = ineligibilityReason(entry);

    return {
      collectionItemId: entry.collectionItemId,
      modelId: entry.modelId,
      modelName: entry.modelName,
      creatorId: entry.creatorId,
      creatorUsername: entry.creatorUsername,
      status: entry.status,
      eligible: !reason,
      ineligibleReason: reason,
      tagId: entry.tagId,
      image: images.get(entry.modelId) ?? null,
      signals,
      rawTotal,
      qualifiedTotal,
      // Share of engagement that failed qualification. High = worth staff eyes.
      disqualifiedShare: rawTotal ? +((rawTotal - qualifiedTotal) / rawTotal).toFixed(3) : 0,
    };
  });

  const categories = [...new Set(entries.map((e) => e.tagId))].map(
    (tagId): ContestScoreCategory => {
      const tagName = entries.find((e) => e.tagId === tagId)?.tagName ?? null;
      const items = scored.filter((e) => e.tagId === tagId);
      const eligible = items.filter((i) => i.eligible);

      // Normalized against the leading ELIGIBLE entry per signal, so an entry pulled
      // after accruing engagement cannot set the bar for everyone else.
      const maxima = Object.fromEntries(
        contestScoreSignals.map((s) => [
          s,
          Math.max(...eligible.map((i) => i.signals[s].qualified), 0),
        ])
      ) as Record<Signal, number>;

      const withScores = items.map(({ tagId: _tagId, ...item }) => {
        let total = 0;
        for (const signal of contestScoreSignals) {
          const max = maxima[signal];
          if (max > 0) total += (item.signals[signal].qualified / max) * config.weights[signal];
        }
        return { ...item, score: item.eligible ? +total.toFixed(4) : 0 };
      });

      const tied = withScores.every((item) => item.score === 0);
      const entriesRanked = withScores
        .sort(
          (a, b) =>
            Number(b.eligible) - Number(a.eligible) ||
            b.score - a.score ||
            b.qualifiedTotal - a.qualifiedTotal ||
            a.modelId - b.modelId
        )
        .map((item, index) => ({ ...item, rank: !item.eligible || tied ? null : index + 1 }));

      return {
        tagId,
        tagName,
        entryCount: items.length,
        eligibleCount: eligible.length,
        soloEntry: eligible.length === 1,
        tied,
        entries: entriesRanked,
      };
    }
  );

  return { ...base, entryCount: entries.length, truncated, categories };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function cacheKeyFor(input: WindowInput, configVersion: number) {
  return `${REDIS_KEYS.CACHES.CONTEST_COMMUNITY_SCORE}:${input.collectionId}:${hashifyObject({
    start: input.start?.toISOString(),
    end: input.end?.toISOString(),
    tagIds: input.tagIds,
    statuses: input.statuses,
    configVersion,
    codeVersion: CONTEST_SCORE_CODE_VERSION,
  })}` as RedisKeyTemplateCache;
}

export async function getCommunityScore(input: GetCommunityScoreInput) {
  const { refresh, ...window } = input;
  try {
    const config = await getContestScoringConfig(window.collectionId);
    const cacheKey = cacheKeyFor(window, config.version);

    if (refresh) await bustFetchThroughCache(cacheKey);

    return await fetchThroughCache(
      cacheKey,
      async () => {
        // One run per collection at a time. A refresh storm would otherwise stack
        // full cross-store aggregations on top of one another.
        const result = await withDistributedLock(
          { key: `contest-score:${window.collectionId}`, ttl: 120, maxRetries: 60 },
          () => computeCommunityScore(window)
        );
        if (!result)
          throw new ContestScoringError(
            'A scoring run for this collection is already in progress. Try again shortly.'
          );
        return result;
      },
      { ttl: SCORE_CACHE_TTL }
    );
  } catch (e) {
    return sanitizeError(window.collectionId, e);
  }
}

/**
 * Engagers on this contest worth a look: accounts acting from IPs shared by many
 * contest engagers, or whose contest engagement concentrates on a single creator.
 * Evidence only — never an automatic disqualification.
 */
export async function getContestCandidates(input: GetContestCandidatesInput) {
  try {
    requireClickhouse();
    const config = await getContestScoringConfig(input.collectionId);
    const window = await resolveWindow(input.collectionId, input, config);
    const limit = input.limit ?? 200;

    const { entries } = await loadEntries(input);
    if (!entries.length) return { collectionId: input.collectionId, count: 0, candidates: [] };

    const gates = await loadGates(window);
    const imagePairs = toImagePairs(await loadImagePairs(entries, window), entries);

    // Reactions and downloads are the engagement events that carry an IP — the same
    // farm-IP signal `reaction-abuse` uses, scoped to this contest. Everything below
    // is aggregated in ClickHouse; only the capped candidate rows come back.
    const imageIds = intList([...new Set(imagePairs.map((p) => p.entityId))]);
    const modelIds = intList([...new Set(entries.map((e) => e.modelId))]);

    const downloadEvents = `
      SELECT s.userId AS userId, p.entryId AS entryId, p.creatorId AS creatorId, s.ip AS ip
      FROM (
        SELECT userId, modelId AS entityId, ip
        FROM modelVersionEvents
        WHERE type = 'Download'
          AND modelId IN (${modelIds || '0'})
          AND time >= ${chDateTime(window.start)} AND time < ${chDateTime(window.effectiveEnd)}
          AND userId != 0
      ) AS s
      INNER JOIN (${chPairTable(modelPairs(entries))}) AS p ON s.entityId = p.entityId
    `;
    const reactionEvents = imagePairs.length
      ? `
      SELECT s.userId AS userId, p.entryId AS entryId, p.creatorId AS creatorId, s.ip AS ip
      FROM (
        SELECT userId, entityId, ip
        FROM reactions
        WHERE type = 'Image_Create'
          AND entityId IN (${imageIds})
          AND time >= ${chDateTime(window.start)} AND time < ${chDateTime(window.effectiveEnd)}
          AND userId != 0
      ) AS s
      INNER JOIN (${chPairTable(imagePairs)}) AS p ON s.entityId = p.entityId
    `
      : null;

    const events = [downloadEvents, reactionEvents].filter(Boolean).join('\nUNION ALL\n');

    const rows = await withSpan('contest-score.candidates', () =>
      clickhouse!.$query<{
        userId: number;
        events: number;
        entriesTouched: number;
        distinctCreators: number;
        topCreator: number;
        toTopCreator: number;
        farmIpsUsed: number;
      }>(`
        WITH ev AS (${events}),
             farm AS (
               SELECT ip FROM ev WHERE ip != '' GROUP BY ip
               HAVING uniqExact(userId) >= ${Number(config.farmIp.minPeers)}
             ),
             perCreator AS (
               SELECT
                 userId,
                 creatorId,
                 count() AS creatorEvents,
                 uniqExact(entryId) AS creatorEntries,
                 groupUniqArrayIf(ip, ip IN (SELECT ip FROM farm)) AS creatorFarmIps
               FROM ev
               GROUP BY userId, creatorId
             )
        SELECT
          userId,
          sum(creatorEvents) AS events,
          sum(creatorEntries) AS entriesTouched,
          count() AS distinctCreators,
          argMax(creatorId, creatorEvents) AS topCreator,
          max(creatorEvents) AS toTopCreator,
          length(arrayDistinct(arrayFlatten(groupArray(creatorFarmIps)))) AS farmIpsUsed
        FROM perCreator
        GROUP BY userId
        HAVING farmIpsUsed > 0
            OR (entriesTouched >= ${Number(config.farmIp.minEntries)} AND distinctCreators = 1)
        ORDER BY toTopCreator / events DESC, farmIpsUsed DESC, events DESC
        LIMIT ${Number(limit)}
      `)
    );

    return {
      collectionId: input.collectionId,
      count: rows.length,
      candidates: rows.map((row) => ({
        userId: Number(row.userId),
        events: Number(row.events),
        entriesTouched: Number(row.entriesTouched),
        distinctCreators: Number(row.distinctCreators),
        topCreator: Number(row.topCreator),
        toTopCreator: Number(row.toTopCreator),
        topCreatorConcentration: +(Number(row.toTopCreator) / Number(row.events)).toFixed(2),
        farmIpsUsed: Number(row.farmIpsUsed),
        // Reported so a reviewer can tell a too-young account from an excluded one
        // without re-deriving the threshold themselves.
        newAccount: Number(row.userId) > gates.userIdThreshold,
      })),
    };
  } catch (e) {
    return sanitizeError(input.collectionId, e);
  }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * The artifact that defends a disputed prize, so it stores the RESOLVED config —
 * weights included — alongside the window, the age cutoff and the code version.
 * Weights are stripped on the wire, never in storage. No userIds are ever stored.
 *
 * KeyValue keeps this migration-free for v1. A dedicated table (indexed by
 * collection, payload out of a jsonb column) is the follow-up once the shape
 * settles.
 */
export type ContestSnapshot = {
  collectionId: number;
  takenAt: string;
  takenById: number;
  takenByUsername: string | null;
  note?: string;
  codeVersion: number;
  config: ContestScoringConfig;
  ageCutoff: string;
  ageGateBandUsers: number;
  partial: boolean;
  score: ContestCommunityScore;
};

export type ContestSnapshotSummary = Omit<ContestSnapshot, 'config' | 'score'> & {
  key: string;
  window: ContestCommunityScore['window'];
  entryCount: number;
};

const snapshotKey = (collectionId: number, takenAt: string) =>
  `${CONTEST_SNAPSHOT_KEY_PREFIX}:${collectionId}:${takenAt}`;

function toSnapshotSummary(key: string, snapshot: ContestSnapshot): ContestSnapshotSummary {
  // `config` — and therefore the weights — is dropped here. It is stored for audit,
  // never served.
  const { config: _config, score, ...rest } = snapshot;
  return { key, ...rest, window: score.window, entryCount: score.entryCount };
}

export async function createContestSnapshot({
  input,
  userId,
  username,
}: {
  input: CreateContestSnapshotInput;
  userId: number;
  username?: string | null;
}): Promise<ContestSnapshotSummary> {
  const { note, ...window } = input;
  try {
    const config = await getContestScoringConfig(window.collectionId);
    const resolved = await resolveWindow(window.collectionId, window, config);
    const gates = await loadGates(resolved);
    const score = await computeCommunityScore(window);

    const takenAt = new Date().toISOString();
    const key = snapshotKey(window.collectionId, takenAt);
    const snapshot: ContestSnapshot = {
      collectionId: window.collectionId,
      takenAt,
      takenById: userId,
      takenByUsername: username ?? null,
      ...(note ? { note } : {}),
      codeVersion: CONTEST_SCORE_CODE_VERSION,
      config,
      ageCutoff: resolved.ageCutoff.toISOString(),
      ageGateBandUsers: gates.ageGateBandUsers,
      partial: resolved.partial,
      score,
    };

    await dbWrite.keyValue.create({
      data: { key, value: snapshot as unknown as Prisma.InputJsonValue },
    });

    return toSnapshotSummary(key, snapshot);
  } catch (e) {
    return sanitizeError(window.collectionId, e);
  }
}

export async function listContestSnapshots({ collectionId }: { collectionId: number }) {
  const rows = await dbRead.keyValue.findMany({
    where: { key: { startsWith: `${CONTEST_SNAPSHOT_KEY_PREFIX}:${collectionId}:` } },
    select: { key: true, value: true },
  });

  return rows
    .map(({ key, value }) => toSnapshotSummary(key, value as unknown as ContestSnapshot))
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}
