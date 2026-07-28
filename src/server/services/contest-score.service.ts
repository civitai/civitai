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
import { v4 as uuid } from 'uuid';
import { CacheTTL, CONTEST_SNAPSHOT_KEY_PREFIX, KEY_VALUE_KEYS } from '~/server/common/constants';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { dbKV } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { collectionMetadataSchema } from '~/server/schema/collection.schema';
import type {
  ContestScoreRunState,
  ContestScoringConfig,
  ContestScoringScope,
  CreateContestSnapshotInput,
  GetCommunityScoreInput,
  GetContestCandidatesInput,
  ContestScoreSignal,
  RunCommunityScoreInput,
  SetContestScoringConfigInput,
} from '~/server/schema/contest-score.schema';
import {
  contestScoreSignals,
  contestScoringConfigSchema,
} from '~/server/schema/contest-score.schema';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { withSpan } from '~/server/utils/otel-helpers';
import { Availability, CollectionItemStatus, CollectionMode } from '~/shared/utils/prisma/enums';
import { signalClient } from '~/utils/signal-client';
import { hashifyObject } from '~/utils/string-helpers';

type Signal = ContestScoreSignal;

/**
 * Every timestamp column this service compares against — `User.createdAt`,
 * `Post.publishedAt`, `CollectionItem.createdAt`, `bannedAt`, `deletedAt` — is
 * `timestamp WITHOUT time zone` holding UTC. A bound `Date` arrives as `timestamptz`
 * and Postgres coerces it using the SESSION timezone, so the comparison is only
 * correct while that session happens to be UTC. Converting explicitly makes it
 * correct under any session timezone.
 */
const utc = (d: Date) => Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;
const nowUtc = Prisma.raw(`(NOW() AT TIME ZONE 'UTC')`);

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
// A finished run stays readable for a day so the tab opens on the last result rather
// than on an empty table waiting for a fresh run.
const RESULT_TTL = CacheTTL.day;
const RUN_STATE_TTL = CacheTTL.hour;
// Entities per ClickHouse call. Chunks are cut along ENTRY boundaries, never entity
// ones: uniqExact cannot be summed across chunks, so every entity belonging to an
// entry has to be counted in the same call.
//
// The ceiling is the query TEXT, not the row count: `chPairTable` inlines every pair
// as a tuple literal, and the cluster caps a query at 262,144 bytes / 50,000 AST
// elements. The measured limit is ~8,000 four-element tuples; 5,000 leaves headroom.
const CH_ENTITY_CHUNK = 5000;
// Ceiling on the reactor lookup table, which scales with images published in the
// window rather than with entry count. Past it the run is flagged truncated.
const MAX_IMAGE_PAIRS = 200000;
const CH_CONCURRENCY = 4;
const DEFAULT_STATUSES: CollectionItemStatus[] = [CollectionItemStatus.ACCEPTED];

/**
 * An error whose message is safe to show the caller — a misconfiguration or a bad
 * request, never a query failure. Everything else is logged and replaced with a
 * generic message, because the ClickHouse `$query` wrapper appends the generated
 * SQL (id lists included) to the errors it throws.
 */
export class ContestScoringError extends Error {}

function safeErrorMessage(collectionId: number, e: unknown) {
  if (e instanceof ContestScoringError) return e.message;
  const error = e as Error;
  logToAxiom(
    { name: 'contest-score', type: 'error', collectionId, message: error?.message },
    'civitai-prod'
  ).catch(() => null);
  console.error('[contest-score] failed', collectionId, error?.message);
  return 'Contest scoring failed. See server logs.';
}

function sanitizeError(collectionId: number, e: unknown): never {
  if (e instanceof ContestScoringError) throw throwBadRequestError(e.message);
  throw new Error(safeErrorMessage(collectionId, e));
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const configKey = (suffix: number | 'default') => `${KEY_VALUE_KEYS.CONTEST_SCORING}:${suffix}`;
const scopeSuffix = (scope: ContestScoringScope, collectionId: number) =>
  scope === 'global' ? ('default' as const) : collectionId;

type ResolvedConfig = { config: ContestScoringConfig; scope: ContestScoringScope };

function parseConfig(collectionId: number, stored: unknown): ContestScoringConfig {
  const parsed = contestScoringConfigSchema.safeParse(stored);
  if (!parsed.success)
    throw new ContestScoringError(
      `The contest scoring config for collection ${collectionId} is malformed: ${parsed.error.message}`
    );
  return parsed.data;
}

/**
 * Per-collection config with a global fallback. One shared row would let a later
 * edit retroactively change a finished contest's ranking.
 *
 * The winning SCOPE travels with the config because it is part of the run's cache
 * identity: a fresh per-collection row can carry a lower `version` than the global
 * one it overrides, so version alone would let the collection-scoped run collide with
 * a stale globally-scoped one.
 */
async function resolveContestScoringConfig(collectionId: number): Promise<ResolvedConfig> {
  const [specific, fallback] = await Promise.all([
    dbKV.get<unknown>(configKey(collectionId)),
    dbKV.get<unknown>(configKey('default')),
  ]);

  if (!specific && !fallback)
    throw new ContestScoringError(
      `Contest scoring is not configured: neither "${configKey(collectionId)}" nor "${configKey(
        'default'
      )}" exists in KeyValue. Weights and thresholds live only in the database — there is no code fallback.`
    );

  return specific
    ? { config: parseConfig(collectionId, specific), scope: 'collection' }
    : { config: parseConfig(collectionId, fallback), scope: 'global' };
}

export async function getContestScoringConfig(collectionId: number): Promise<ContestScoringConfig> {
  return (await resolveContestScoringConfig(collectionId)).config;
}

/**
 * The moderator-facing read. Deliberately a SEPARATE procedure from the scoring
 * query: the score payload carries no weights, denominators or thresholds, so
 * relaxing the gate on one endpoint cannot expose the other.
 */
export async function getContestScoringConfigForEditor(collectionId: number) {
  try {
    const [specific, fallback] = await Promise.all([
      dbKV.get<unknown>(configKey(collectionId)),
      dbKV.get<unknown>(configKey('default')),
    ]);

    return {
      collectionId,
      effectiveScope: (specific ? 'collection' : 'global') as ContestScoringScope,
      collection: specific ? parseConfig(collectionId, specific) : null,
      global: fallback ? parseConfig(collectionId, fallback) : null,
    };
  } catch (e) {
    return sanitizeError(collectionId, e);
  }
}

/**
 * Append-only audit rows, one per edit:
 *   contestScoring:audit:<collectionId|default>:<ISO>
 *
 * Written with `create` inside the same transaction as the config write, so a
 * config change that is not accompanied by an audit row cannot exist. `create` and
 * not `upsert`: colliding on an existing row must fail loudly rather than silently
 * rewrite history.
 */
const auditKey = (suffix: number | 'default', at: string) =>
  `${KEY_VALUE_KEYS.CONTEST_SCORING}:audit:${suffix}:${at}`;

export async function setContestScoringConfig({
  input,
  userId,
  username,
}: {
  input: SetContestScoringConfigInput;
  userId: number;
  username?: string | null;
}) {
  const { collectionId, scope, config, reason } = input;
  try {
    const suffix = scopeSuffix(scope, collectionId);
    const key = configKey(suffix);

    const [existingRaw, defaultRaw] = await Promise.all([
      dbKV.get<unknown>(key),
      dbKV.get<unknown>(configKey('default')),
    ]);
    const existing = existingRaw ? parseConfig(collectionId, existingRaw) : null;
    const globalConfig = defaultRaw ? parseConfig(collectionId, defaultRaw) : null;

    // Above BOTH rows, never just the one being written. A per-collection row that
    // started below the global version could otherwise mint a cache identity a
    // previous run already used.
    const version = Math.max(existing?.version ?? 0, globalConfig?.version ?? 0) + 1;
    const updatedAt = new Date().toISOString();
    const next: ContestScoringConfig = {
      ...config,
      version,
      updatedById: userId,
      updatedByUsername: username ?? null,
      updatedAt,
    };

    await dbWrite.$transaction([
      dbWrite.keyValue.upsert({
        where: { key },
        create: { key, value: next as unknown as Prisma.InputJsonValue },
        update: { value: next as unknown as Prisma.InputJsonValue },
      }),
      dbWrite.keyValue.create({
        data: {
          key: auditKey(suffix, updatedAt),
          value: {
            userId,
            username: username ?? null,
            scope,
            collectionId,
            ...(reason ? { reason } : {}),
            before: existing,
            after: next,
          } as unknown as Prisma.InputJsonValue,
        },
      }),
    ]);

    // The version bump already orphans every result key this collection had cached
    // (version is part of the key), so the stale result is unreachable and TTLs out.
    // Dropping the run pointer is what stops the UI from presenting it as current.
    await clearLatestRun(collectionId);

    return { scope, version, updatedAt };
  } catch (e) {
    return sanitizeError(collectionId, e);
  }
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

type BaseGates = {
  userIdThreshold: number;
  ageGateBandUsers: number;
  baseDisqualifiedIds: number[];
};

type Gates = BaseGates & {
  /** Base list plus the banned/deleted engagers resolved for THIS contest. */
  disqualifiedIds: number[];
  /** Set when the engager set blew the cap and the ban refinement was skipped. */
  bannedRefinementSkipped: boolean;
  engagerCount: number;
};

/**
 * `User.id` is autoincrement but NOT strictly monotonic with `createdAt` — at least
 * one backdated system account exists. `max(id) WHERE createdAt <= cutoff` would let
 * that single row drag the threshold up and wave through every account registered
 * since. `min(id) WHERE createdAt > cutoff` minus one can only ever be too strict,
 * which is the safe direction for an anti-cheat gate.
 *
 * `User` has no index on `createdAt`, so the planner walks the primary key from id 1
 * discarding ~12.7M rows: ~12s, and the single largest cost in a run. The answer is
 * a pure function of the cutoff and effectively immutable (a later registration
 * always has both a higher id and a later `createdAt`), so it is cached hard. An
 * index on `User."createdAt"` would make this instant and let the cache go.
 */
async function loadAgeThreshold(ageCutoff: Date) {
  const key = `${
    REDIS_KEYS.CACHES.CONTEST_COMMUNITY_SCORE
  }:age-threshold:${ageCutoff.toISOString()}` as RedisKeyTemplateCache;

  return fetchThroughCache(
    key,
    () =>
      withSpan('contest-score.age-threshold', async () => {
        // Two statements, not one: as a single CTE the planner materializes the band
        // count against an unknown threshold and the query takes ~50s instead of ~12s.
        const [{ threshold }] = await dbRead.$queryRaw<{ threshold: number }[]>`
          SELECT COALESCE(
            (SELECT min(id) FROM "User" WHERE "createdAt" > ${utc(ageCutoff)}) - 1,
            (SELECT max(id) FROM "User")
          )::int AS "threshold"
        `;
        const [{ bandUsers }] = await dbRead.$queryRaw<{ bandUsers: number }[]>`
          SELECT count(*)::int AS "bandUsers"
          FROM "User" u
          WHERE u."createdAt" <= ${utc(ageCutoff)} AND u.id > ${threshold}
        `;
        return { threshold, bandUsers };
      }),
    { ttl: CacheTTL.week, lockTTL: 60 }
  );
}

/** The always-on gates: cheap, bounded, and enough to bound the engager set. */
async function loadBaseGates(ageCutoff: Date) {
  const threshold = await loadAgeThreshold(ageCutoff);

  if (threshold.bandUsers)
    console.warn(
      `[contest-score] age gate band holds ${threshold.bandUsers} user(s) registered before the cutoff but carrying an id above the threshold; they are disqualified.`
    );

  const [excluded, contestBanned] = await Promise.all([
    withSpan('contest-score.excluded-users', () =>
      clickhouse!.$query<{ userId: number }>(`
        SELECT userId FROM metricExcludedUsers FINAL WHERE active = 1
      `)
    ),
    withSpan(
      'contest-score.contest-banned',
      () =>
        dbRead.$queryRaw<{ id: number }[]>`
        SELECT u.id FROM "User" u WHERE u.meta ->> 'contestBanDetails' IS NOT NULL
      `
    ),
  ]);

  return {
    userIdThreshold: threshold.threshold,
    ageGateBandUsers: threshold.bandUsers,
    baseDisqualifiedIds: [
      ...new Set([...excluded.map((e) => Number(e.userId)), ...contestBanned.map((u) => u.id)]),
    ].sort((a, b) => a - b),
  };
}

// Postgres caps a statement at 65,535 bind parameters. Chunked well under it so this
// is a bounded loop rather than a cliff a big contest walks off.
const PG_ID_CHUNK = 10000;

/**
 * Resolves banned / deleted / vanished accounts against the ENGAGER set rather than
 * the other way round. The banned-or-deleted population is ~1.35M rows and must
 * never be pushed into ClickHouse; the engagers on a contest number in the
 * thousands, so the small side is the one that travels.
 *
 * An id with no `User` row at all is a hard-deleted account and never counts.
 */
async function resolveBannedEngagers(engagerIds: number[]) {
  if (!engagerIds.length) return [] as number[];

  const disqualified: number[] = [];
  for (let i = 0; i < engagerIds.length; i += PG_ID_CHUNK) {
    const chunk = engagerIds.slice(i, i + PG_ID_CHUNK);
    const rows = await dbRead.$queryRaw<{ id: number; gone: boolean }[]>`
      SELECT ids.id, (u.id IS NULL OR u."bannedAt" IS NOT NULL OR u."deletedAt" IS NOT NULL) AS "gone"
      FROM unnest(ARRAY[${Prisma.join(chunk)}]::int[]) AS ids(id)
      LEFT JOIN "User" u ON u.id = ids.id
    `;
    for (const row of rows) if (row.gone) disqualified.push(row.id);
  }

  return disqualified;
}

/**
 * Distinct users who engaged through a ClickHouse signal, already narrowed by the
 * age gate and the base exclusions. Postgres signals do not need this — they join
 * `User` inline — so only the three ClickHouse signals pay the round trip.
 */
async function collectChEngagers(
  sources: string[],
  base: { userIdThreshold: number; baseDisqualifiedIds: number[] }
) {
  const disqualified = base.baseDisqualifiedIds.length ? intList(base.baseDisqualifiedIds) : '0';

  const results = await withSpan('contest-score.engagers', () => {
    const limit = pLimit(CH_CONCURRENCY);
    return Promise.all(
      sources.map((source) =>
        limit(() =>
          clickhouse!.$query<{ userId: number }>(`
            SELECT DISTINCT userId
            FROM (${source}) AS s
            WHERE userId <= ${base.userIdThreshold} AND userId NOT IN (${disqualified})
          `)
        )
      )
    );
  });

  return [...new Set(results.flat().map((r) => Number(r.userId)))];
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
        AND p."publishedAt" <= ${nowUtc}
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
      toInt64(p.1) AS entityId,
      toInt64(p.2) AS entryId,
      toInt64(p.3) AS creatorId,
      toInt64(p.4) AS addedById
    FROM (SELECT arrayJoin([${tuples}]) AS p)
  `;
}

/**
 * Seconds since the epoch, never a formatted string. `toDateTime('2026-07-24
 * 00:00:00')` is parsed in the ClickHouse SERVER timezone, so a literal silently
 * shifts the window; an integer is an absolute instant.
 */
const chDateTime = (d: Date) => `toDateTime(${Math.floor(d.getTime() / 1000)})`;

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
 * Splits pairs into calls, cutting only between ENTRIES. An entry's entities must all
 * land in one call because uniqExact cannot be summed across chunks.
 */
function chunkPairsByEntry(pairs: EntryPair[]) {
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

  return chunks;
}

/** Runs the chunks with bounded concurrency so a big contest cannot fan out unboundedly. */
async function runChCounts(
  name: string,
  pairs: EntryPair[],
  gates: Gates,
  source: (entityIds: string) => string
): Promise<SignalCount[]> {
  if (!pairs.length) return [];

  const chunks = chunkPairsByEntry(pairs);

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
function pgQualified(userColumn: string, userAlias: string, gates: BaseGates) {
  const disqualified = gates.baseDisqualifiedIds.length ? intList(gates.baseDisqualifiedIds) : '-1';
  // Postgres can see the ban columns directly, so the engager round trip the
  // ClickHouse signals need is unnecessary here — the predicate is the same one.
  return Prisma.raw(`
    ${userColumn} <> e."creatorId"
    AND (e."addedById" IS NULL OR ${userColumn} <> e."addedById")
    AND ${userColumn} <= ${gates.userIdThreshold}
    AND NOT (${userColumn} = ANY(ARRAY[${disqualified}]::int[]))
    AND ${userAlias}.id IS NOT NULL
    AND ${userAlias}."bannedAt" IS NULL
    AND ${userAlias}."deletedAt" IS NULL
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
        AND p."publishedAt" <= ${nowUtc}
        AND p."publishedAt" >= ${utc(window.start)}
        AND p."publishedAt" < ${utc(window.effectiveEnd)}
        AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
    `
  );
}

async function countImageAuthors(entries: EntryRow[], window: ResolvedWindow, gates: BaseGates) {
  return withSpan(
    'contest-score.image-authors',
    () =>
      dbRead.$queryRaw<SignalCount[]>`
      SELECT
        e."entryId"                     AS "collectionItemId",
        count(DISTINCT i."userId")::int AS "rawUsers",
        count(DISTINCT i."userId") FILTER (WHERE ${pgQualified('i."userId"', 'au', gates)})::int
                                        AS "qualifiedUsers"
      FROM ${pgEntryTable(entries)}
      JOIN "ModelVersion" mv ON mv."modelId" = e."modelId"
      JOIN "ImageResourceNew" ir ON ir."modelVersionId" = mv.id
      JOIN "Image" i ON i.id = ir."imageId"
      JOIN "Post" p ON p.id = i."postId"
      LEFT JOIN "User" au ON au.id = i."userId"
      WHERE p."publishedAt" IS NOT NULL
        AND p."publishedAt" <= ${nowUtc}
        AND p."publishedAt" >= ${utc(window.start)}
        AND p."publishedAt" < ${utc(window.effectiveEnd)}
        AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
      GROUP BY e."entryId"
    `
  );
}

async function countCollectors(
  entries: EntryRow[],
  window: ResolvedWindow,
  gates: BaseGates,
  collectionId: number
) {
  return withSpan(
    'contest-score.collectors',
    () =>
      dbRead.$queryRaw<SignalCount[]>`
      SELECT
        e."entryId"                         AS "collectionItemId",
        count(DISTINCT ci."addedById")::int AS "rawUsers",
        count(DISTINCT ci."addedById") FILTER (WHERE ${pgQualified(
          'ci."addedById"',
          'cu',
          gates
        )})::int
                                            AS "qualifiedUsers"
      FROM ${pgEntryTable(entries)}
      JOIN "CollectionItem" ci ON ci."modelId" = e."modelId"
      LEFT JOIN "User" cu ON cu.id = ci."addedById"
      WHERE ci."collectionId" <> ${collectionId}
        AND ci."addedById" IS NOT NULL
        AND ci."createdAt" >= ${utc(window.start)}
        AND ci."createdAt" < ${utc(window.effectiveEnd)}
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
  //
  // ⚠️ Dropping it does NOT make this payload weight-safe. Normalization is
  // max-within-category, so a caller holding every entry in a category can
  // reconstruct each maximum from `qualified` and solve for the weights from
  // `score`. `moderatorProcedure` on every procedure is what actually closes the
  // oracle. Do not relax that gate on the belief that the payload is safe alone.
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
  truncated: { entries: boolean; images: boolean };
  /**
   * Set when a bound was hit and part of the qualification was skipped. Degrading
   * loudly matters more than degrading gracefully for an artifact that decides a
   * prize.
   */
  degraded: { bannedRefinementSkipped: boolean };
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

/** Filled in during a run for the snapshot's audit trail; never sent to a client. */
type RunAudit = { engagerCount: number; ageGateBandUsers: number };

async function computeCommunityScore(
  input: WindowInput,
  audit?: RunAudit
): Promise<ContestCommunityScore> {
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
  if (!entries.length)
    return {
      ...base,
      entryCount: 0,
      truncated: { entries: truncated, images: false },
      degraded: { bannedRefinementSkipped: false },
      categories: [],
    };

  const baseGates = await loadBaseGates(window.ageCutoff);

  const [imageAuthors, collectors, imageRowsRaw, versionPairs, images] = await Promise.all([
    countImageAuthors(entries, window, baseGates),
    countCollectors(entries, window, baseGates, input.collectionId),
    loadImagePairs(entries, window),
    loadVersionPairs(entries),
    loadEntryImages(entries.map((e) => e.modelId)),
  ]);

  const truncatedImages = imageRowsRaw.length > MAX_IMAGE_PAIRS;
  const imageRows = truncatedImages ? imageRowsRaw.slice(0, MAX_IMAGE_PAIRS) : imageRowsRaw;
  const imagePairs = toImagePairs(imageRows, entries);

  const chSources = {
    reactors: (ids: string) => `
      SELECT toInt64(userId) AS userId, toInt64(entityId) AS entityId
      FROM reactions
      WHERE type = 'Image_Create'
        AND entityId IN (${ids})
        AND time >= ${chDateTime(window.start)} AND time < ${chDateTime(window.effectiveEnd)}
        AND userId != 0
    `,
    downloaders: (ids: string) => `
      SELECT toInt64(userId) AS userId, toInt64(modelId) AS entityId
      FROM modelVersionEvents
      WHERE type = 'Download'
        AND modelId IN (${ids})
        AND time >= ${chDateTime(window.start)} AND time < ${chDateTime(window.effectiveEnd)}
        AND userId != 0
    `,
    // Straight off orchestration.jobs, NOT default.daily_user_resource: that view
    // only ingests jobType IN ('TextToImage','TextToImageV2','Comfy'), so every
    // newer engine (ComfyImageGen, AnimaComfy, StableDiffusionCpp, …) is missing
    // from it and whole ecosystems read as zero generations.
    generators: (ids: string) => `
      SELECT toInt64(userId) AS userId, toInt64(resource) AS entityId
      FROM orchestration.jobs
      ARRAY JOIN resourcesUsed AS resource
      WHERE resource IN (${ids})
        AND createdAt >= ${chDateTime(window.start)}
        AND createdAt < ${chDateTime(window.effectiveEnd)}
        AND userId != 0
    `,
  };

  const imageIds = intList([...new Set(imagePairs.map((p) => p.entityId))]) || '0';
  const modelIds = intList([...new Set(entries.map((e) => e.modelId))]) || '0';
  const versionIds = intList([...new Set(versionPairs.map((p) => p.entityId))]) || '0';

  // Resolve banned/deleted against the ENGAGERS, not the other way round: the
  // banned-or-deleted population is ~1.35M rows and must never reach ClickHouse.
  const engagers = await collectChEngagers(
    [
      chSources.reactors(imageIds),
      chSources.downloaders(modelIds),
      chSources.generators(versionIds),
    ],
    baseGates
  );

  const bannedRefinementSkipped = engagers.length > config.maxEngagers;
  if (bannedRefinementSkipped)
    console.warn(
      `[contest-score] collection ${input.collectionId} has ${engagers.length} engagers, above the configured ceiling; the banned/deleted refinement was skipped and the run is flagged degraded.`
    );

  const gates: Gates = {
    ...baseGates,
    disqualifiedIds: bannedRefinementSkipped
      ? baseGates.baseDisqualifiedIds
      : [
          ...new Set([
            ...baseGates.baseDisqualifiedIds,
            ...(await resolveBannedEngagers(engagers)),
          ]),
        ].sort((a, b) => a - b),
    bannedRefinementSkipped,
    engagerCount: engagers.length,
  };

  if (audit) {
    audit.engagerCount = gates.engagerCount;
    audit.ageGateBandUsers = gates.ageGateBandUsers;
  }

  const [reactors, downloaders, generators] = await Promise.all([
    runChCounts('reactors', imagePairs, gates, chSources.reactors),
    runChCounts('downloaders', modelPairs(entries), gates, chSources.downloaders),
    runChCounts('generators', versionPairs, gates, chSources.generators),
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
      //
      // Floored at the configured minDenominator: where a category's leading count is
      // tiny, a bare maximum lets one or two users swing a signal from 0 to 0.5 and
      // decide a placement on noise.
      const maxima = Object.fromEntries(
        contestScoreSignals.map((s) => [
          s,
          Math.max(...eligible.map((i) => i.signals[s].qualified), 0, config.minDenominator[s]),
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

  return {
    ...base,
    entryCount: entries.length,
    truncated: { entries: truncated, images: truncatedImages },
    degraded: { bannedRefinementSkipped },
    categories,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const runNamespace = (collectionId: number) =>
  `${REDIS_KEYS.CACHES.CONTEST_SCORE_RUN}:${collectionId}`;
const runStateKey = (collectionId: number, runId: string) =>
  `${runNamespace(collectionId)}:run:${runId}` as RedisKeyTemplateCache;
const latestRunKey = (collectionId: number) =>
  `${runNamespace(collectionId)}:latest` as RedisKeyTemplateCache;

/**
 * A run's identity: the window, the filters, and the exact config and code that
 * produced it. A config edit bumps `version`, so the previous result becomes
 * unreachable at its old key and expires on its own rather than being served as if
 * the new weights had produced it.
 */
function resultKeyFor(
  input: WindowInput,
  config: ContestScoringConfig,
  scope: ContestScoringScope
) {
  return `${runNamespace(input.collectionId)}:result:${hashifyObject({
    start: input.start?.toISOString(),
    end: input.end?.toISOString(),
    tagIds: input.tagIds,
    statuses: input.statuses,
    configScope: scope,
    configVersion: config.version,
    codeVersion: CONTEST_SCORE_CODE_VERSION,
  })}` as RedisKeyTemplateCache;
}

async function clearLatestRun(collectionId: number) {
  await redis.del(latestRunKey(collectionId)).catch(() => null);
}

/**
 * Run state is Redis-only and every key carries a TTL, so the namespace self-cleans
 * and an abandoned run cannot outlive its usefulness. The signal is best-effort: the
 * state in Redis is the truth, and the read query returns it, so a dropped push
 * costs a refresh rather than a stuck UI.
 */
async function publishRunState(state: ContestScoreRunState) {
  await Promise.all([
    redis.packed.set(runStateKey(state.collectionId, state.runId), state, { EX: RUN_STATE_TTL }),
    redis.packed.set(latestRunKey(state.collectionId), state, { EX: RUN_STATE_TTL }),
  ]);

  signalClient
    .topicSend({
      topic: `${SignalTopic.ContestScore}:${state.collectionId}`,
      target: SignalMessages.ContestScoreRunUpdate,
      // Run bookkeeping only. A topic is joinable by any connected client, so no
      // score and no config value may ride on this payload.
      data: state,
    })
    .catch((error: Error) =>
      console.error('[contest-score] failed to signal run state', state.runId, error?.message)
    );
}

async function readRunState(collectionId: number) {
  return (await redis.packed.get<ContestScoreRunState>(latestRunKey(collectionId))) ?? null;
}

async function executeRun(input: WindowInput, state: ContestScoreRunState) {
  const startedAt = new Date().toISOString();
  await publishRunState({ ...state, status: 'running', startedAt });

  try {
    const { config, scope } = await resolveContestScoringConfig(input.collectionId);

    // One run per collection at a time. Nothing is waiting on the response now, so
    // the loser of the race waits for the lock rather than failing the caller.
    const result = await withDistributedLock(
      { key: `contest-score:${input.collectionId}`, ttl: 600, retryDelay: 500, maxRetries: 240 },
      () => computeCommunityScore(input)
    );
    if (!result)
      throw new ContestScoringError(
        'A scoring run for this collection is already in progress. Try again shortly.'
      );

    await redis.packed.set(resultKeyFor(input, config, scope), result, { EX: RESULT_TTL });
    await publishRunState({
      ...state,
      status: 'done',
      startedAt,
      finishedAt: new Date().toISOString(),
      generatedAt: result.generatedAt,
    });
  } catch (e) {
    await publishRunState({
      ...state,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: safeErrorMessage(input.collectionId, e),
    });
  }
}

/**
 * Enqueues a run and returns immediately. The compute is detached on purpose: a full
 * cross-store aggregation outlives a request timeout on a large contest, and the run
 * state in Redis — not the HTTP response — is what the UI follows.
 */
export async function runCommunityScore({
  input,
  userId,
}: {
  input: RunCommunityScoreInput;
  userId: number;
}): Promise<ContestScoreRunState> {
  try {
    // Resolved before enqueueing so a misconfiguration or a non-contest collection
    // fails the mutation rather than surfacing minutes later as a failed run.
    requireClickhouse();
    const { config } = await resolveContestScoringConfig(input.collectionId);
    await resolveWindow(input.collectionId, input, config);

    const state: ContestScoreRunState = {
      runId: uuid(),
      collectionId: input.collectionId,
      status: 'queued',
      requestedBy: userId,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      generatedAt: null,
    };
    await publishRunState(state);

    void executeRun(input, state).catch((error: Error) =>
      console.error('[contest-score] run crashed', state.runId, error?.message)
    );

    return state;
  } catch (e) {
    return sanitizeError(input.collectionId, e);
  }
}

/**
 * Read-only. Returns whatever the last completed run produced for this window plus
 * the current run state; it never computes. The client keeps the previous result on
 * screen while a run is in flight, so a run starting must not blank the table.
 */
export async function getCommunityScore(input: GetCommunityScoreInput) {
  try {
    const { config, scope } = await resolveContestScoringConfig(input.collectionId);
    const [result, run] = await Promise.all([
      redis.packed.get<ContestCommunityScore>(resultKeyFor(input, config, scope)),
      readRunState(input.collectionId),
    ]);

    return { result: result ?? null, run };
  } catch (e) {
    return sanitizeError(input.collectionId, e);
  }
}

/**
 * Engagers on this contest worth a look: accounts acting from IPs shared by many
 * contest engagers, or whose contest engagement concentrates on a single creator.
 * Evidence only — never an automatic disqualification.
 *
 * Unlike the scoring path this legitimately returns user ids — that IS the report —
 * so it aggregates per (user, creator) in ClickHouse and merges in Node. The
 * intermediate is bounded by the engager ceiling, and the response by `limit`.
 * Farm-IP peer counts have to be global, so they are built from the merged set
 * rather than per chunk, where they would undercount.
 */
export async function getContestCandidates(input: GetContestCandidatesInput) {
  try {
    requireClickhouse();
    const config = await getContestScoringConfig(input.collectionId);
    const window = await resolveWindow(input.collectionId, input, config);
    const limit = input.limit ?? 200;

    const { entries } = await loadEntries(input);
    if (!entries.length) return { collectionId: input.collectionId, count: 0, candidates: [] };

    const baseGates = await loadBaseGates(window.ageCutoff);
    const imagePairs = toImagePairs(await loadImagePairs(entries, window), entries);

    // Reactions and downloads are the engagement events that carry an IP — the same
    // farm-IP signal `reaction-abuse` uses, scoped to this contest.
    const perCreator = (
      await Promise.all([
        runChPerCreator(
          'candidates.downloads',
          modelPairs(entries),
          (ids) => `
          SELECT toInt64(userId) AS userId, toInt64(modelId) AS entityId, ip
          FROM modelVersionEvents
          WHERE type = 'Download'
            AND modelId IN (${ids})
            AND time >= ${chDateTime(window.start)} AND time < ${chDateTime(window.effectiveEnd)}
            AND userId != 0
        `
        ),
        runChPerCreator(
          'candidates.reactions',
          imagePairs,
          (ids) => `
          SELECT toInt64(userId) AS userId, toInt64(entityId) AS entityId, ip
          FROM reactions
          WHERE type = 'Image_Create'
            AND entityId IN (${ids})
            AND time >= ${chDateTime(window.start)} AND time < ${chDateTime(window.effectiveEnd)}
            AND userId != 0
        `
        ),
      ])
    ).flat();

    const usersPerIp = new Map<string, Set<number>>();
    for (const row of perCreator)
      for (const ip of row.ips) {
        if (!ip) continue;
        if (!usersPerIp.has(ip)) usersPerIp.set(ip, new Set());
        usersPerIp.get(ip)!.add(row.userId);
      }
    const farmIps = new Set(
      [...usersPerIp.entries()]
        .filter(([, users]) => users.size >= config.farmIp.minPeers)
        .map(([ip]) => ip)
    );

    type Candidate = {
      events: number;
      entriesTouched: number;
      creators: Map<number, number>;
      farmIps: Set<string>;
    };
    const byUser = new Map<number, Candidate>();
    for (const row of perCreator) {
      let candidate = byUser.get(row.userId);
      if (!candidate) {
        candidate = { events: 0, entriesTouched: 0, creators: new Map(), farmIps: new Set() };
        byUser.set(row.userId, candidate);
      }
      candidate.events += row.events;
      candidate.entriesTouched += row.entries;
      candidate.creators.set(
        row.creatorId,
        (candidate.creators.get(row.creatorId) ?? 0) + row.events
      );
      for (const ip of row.ips) if (farmIps.has(ip)) candidate.farmIps.add(ip);
    }

    const rows = [...byUser.entries()]
      .map(([userId, candidate]) => {
        const [topCreator, toTopCreator] = [...candidate.creators.entries()].sort(
          (a, b) => b[1] - a[1]
        )[0] ?? [0, 0];
        return {
          userId,
          events: candidate.events,
          entriesTouched: candidate.entriesTouched,
          distinctCreators: candidate.creators.size,
          topCreator,
          toTopCreator,
          topCreatorConcentration: +(toTopCreator / candidate.events).toFixed(2),
          farmIpsUsed: candidate.farmIps.size,
          // Reported so a reviewer can tell a too-young account from an excluded one
          // without re-deriving the threshold themselves.
          newAccount: userId > baseGates.userIdThreshold,
        };
      })
      .filter(
        (row) =>
          row.farmIpsUsed > 0 ||
          (row.entriesTouched >= config.farmIp.minEntries && row.distinctCreators === 1)
      )
      // Concentration on one creator is the discriminating signal; farm IPs alone
      // catch shared/CGNAT addresses too, so they only break ties.
      .sort(
        (a, b) =>
          b.topCreatorConcentration - a.topCreatorConcentration ||
          b.farmIpsUsed - a.farmIpsUsed ||
          b.events - a.events
      )
      .slice(0, limit);

    return { collectionId: input.collectionId, count: rows.length, candidates: rows };
  } catch (e) {
    return sanitizeError(input.collectionId, e);
  }
}

type PerCreatorRow = {
  userId: number;
  creatorId: number;
  events: number;
  entries: number;
  ips: string[];
};

/** Same entry-boundary chunking as the scoring path — the query-text ceiling is identical. */
async function runChPerCreator(
  name: string,
  pairs: EntryPair[],
  source: (entityIds: string) => string
): Promise<PerCreatorRow[]> {
  if (!pairs.length) return [];

  return withSpan(`contest-score.${name}`, { pairs: pairs.length }, async () => {
    const limit = pLimit(CH_CONCURRENCY);
    const results = await Promise.all(
      chunkPairsByEntry(pairs).map((chunk) =>
        limit(() => {
          const entityIds = intList([...new Set(chunk.map((p) => p.entityId))]);
          return clickhouse!.$query<PerCreatorRow>(`
            SELECT
              s.userId AS userId,
              p.creatorId AS creatorId,
              count() AS events,
              uniqExact(p.entryId) AS entries,
              groupUniqArray(s.ip) AS ips
            FROM (${source(entityIds)}) AS s
            INNER JOIN (${chPairTable(chunk)}) AS p ON s.entityId = p.entityId
            GROUP BY userId, creatorId
          `);
        })
      )
    );
    return results.flat().map((row) => ({
      userId: Number(row.userId),
      creatorId: Number(row.creatorId),
      events: Number(row.events),
      entries: Number(row.entries),
      ips: row.ips ?? [],
    }));
  });
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * Which deployment produced a snapshot, derived from the ENVIRONMENT and never from
 * mutation input — an operator cannot forget it and a client cannot spoof it.
 * Preview namespaces carry these vars; production carries none of them.
 */
function snapshotSource() {
  if (process.env.IS_PREVIEW !== 'true' && process.env.NEXT_PUBLIC_IS_PR_PREVIEW !== 'true')
    return null;
  const pr = process.env.NEXT_PUBLIC_PR_NUMBER;
  return pr ? `preview-${pr}` : 'preview';
}

/**
 * The artifact that defends a disputed prize, so it stores the RESOLVED config —
 * weights included — alongside the window, the age cutoff and the code version.
 * Weights are stripped on the wire, never in storage. No userIds are ever stored.
 *
 * The source marker is in the KEY as well as the value so preview rows are a prefix
 * delete rather than a deserialize-and-filter:
 *   contestSnapshot:<collectionId>:preview-<pr>:<ISO>
 *   contestSnapshot:<collectionId>:<ISO>
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
  source: string | null;
  note?: string;
  codeVersion: number;
  config: ContestScoringConfig;
  ageCutoff: string;
  /**
   * Diagnostic only. The threshold is cached for a week, so this can be up to that
   * stale — it is NOT a measurement taken at snapshot time.
   */
  ageGateBandUsers: number;
  engagerCount: number;
  partial: boolean;
  score: ContestCommunityScore;
};

export type ContestSnapshotSummary = Omit<ContestSnapshot, 'config' | 'score'> & {
  key: string;
  window: ContestCommunityScore['window'];
  entryCount: number;
};

const snapshotKey = (collectionId: number, takenAt: string, source: string | null) =>
  [CONTEST_SNAPSHOT_KEY_PREFIX, collectionId, ...(source ? [source] : []), takenAt].join(':');

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
    const audit: RunAudit = { engagerCount: 0, ageGateBandUsers: 0 };

    // Through the same lock the scoring path uses. Snapshotting is a full run, so two
    // mods clicking the button would otherwise stack exactly what the lock exists to
    // prevent.
    const score = await withDistributedLock(
      { key: `contest-score:${window.collectionId}`, ttl: 120, maxRetries: 60 },
      () => computeCommunityScore(window, audit)
    );
    if (!score)
      throw new ContestScoringError(
        'A scoring run for this collection is already in progress. Try again shortly.'
      );

    const takenAt = new Date().toISOString();
    const source = snapshotSource();
    const key = snapshotKey(window.collectionId, takenAt, source);
    const snapshot: ContestSnapshot = {
      collectionId: window.collectionId,
      takenAt,
      takenById: userId,
      takenByUsername: username ?? null,
      source,
      ...(note ? { note } : {}),
      codeVersion: CONTEST_SCORE_CODE_VERSION,
      config,
      ageCutoff: resolved.ageCutoff.toISOString(),
      ageGateBandUsers: audit.ageGateBandUsers,
      engagerCount: audit.engagerCount,
      partial: resolved.partial,
      score,
    };

    try {
      await dbWrite.keyValue.create({
        data: { key, value: snapshot as unknown as Prisma.InputJsonValue },
      });
    } catch (e) {
      // Never an upsert: overwriting a judging artifact silently is worse than
      // failing. Only the message is softened.
      if ((e as { code?: string }).code === 'P2002')
        throw new ContestScoringError('A snapshot for this instant already exists.');
      throw e;
    }

    return toSnapshotSummary(key, snapshot);
  } catch (e) {
    return sanitizeError(window.collectionId, e);
  }
}

export type ContestSnapshotRef = { key: string; source: string | null; takenAt: string };

/**
 * The key carries everything the list needs, so `takenAt` and the source marker are
 * read back off it: `<prefix>:<collectionId>:[source:]<ISO>`. The ISO timestamp
 * contains colons of its own, hence the leading-year test rather than a field count.
 */
function parseSnapshotKey(collectionId: number, key: string): ContestSnapshotRef | null {
  const prefix = `${CONTEST_SNAPSHOT_KEY_PREFIX}:${collectionId}:`;
  if (!key.startsWith(prefix)) return null;

  const rest = key.slice(prefix.length);
  if (/^\d{4}-/.test(rest)) return { key, source: null, takenAt: rest };

  const split = rest.indexOf(':');
  if (split < 0) return null;
  return { key, source: rest.slice(0, split), takenAt: rest.slice(split + 1) };
}

/**
 * Keys only. Every snapshot embeds a full scored payload, so deserializing the set
 * just to render a list of dates would grow with entries × snapshots for a list that
 * shows neither. The value is fetched for ONE snapshot, on click.
 */
export async function listContestSnapshots({ collectionId }: { collectionId: number }) {
  try {
    const rows = await dbRead.keyValue.findMany({
      where: { key: { startsWith: `${CONTEST_SNAPSHOT_KEY_PREFIX}:${collectionId}:` } },
      select: { key: true },
    });

    return rows
      .map(({ key }) => parseSnapshotKey(collectionId, key))
      .filter((ref): ref is ContestSnapshotRef => !!ref)
      .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  } catch (e) {
    return sanitizeError(collectionId, e);
  }
}

export async function getContestSnapshot({
  collectionId,
  key,
}: {
  collectionId: number;
  key: string;
}) {
  try {
    // The key is client-supplied, so it is re-derived against this collection's
    // prefix before it reaches the query — a KeyValue lookup by arbitrary key would
    // read any row in the table, config and audit rows included.
    if (!parseSnapshotKey(collectionId, key))
      throw new ContestScoringError('That snapshot does not belong to this collection.');

    const row = await dbRead.keyValue.findUnique({ where: { key }, select: { value: true } });
    if (!row) throw new ContestScoringError('Snapshot not found.');

    const snapshot = row.value as unknown as ContestSnapshot;
    // `config` — and therefore the weights — is dropped by toSnapshotSummary. It is
    // stored for audit, never served.
    return { ...toSnapshotSummary(key, snapshot), score: snapshot.score };
  } catch (e) {
    return sanitizeError(collectionId, e);
  }
}
