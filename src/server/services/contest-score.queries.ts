/**
 * Data access for contest scoring: every Postgres and ClickHouse query the scorer
 * runs, plus the gate and id-list helpers that sit against them.
 *
 * Split out of `contest-score.service.ts`, which had grown past 2,300 lines. The seam
 * is deliberate rather than an arbitrary halving: this module knows how to ASK the two
 * stores things, and nothing about weights, normalization, ranking or snapshots. The
 * service keeps all of that and never writes SQL.
 *
 * The dependency runs one way — service imports queries, never the reverse — so the
 * shared types and the error class live here, at the bottom of the graph.
 *
 * Server-only. Nothing the client imports may reach this module: it pulls
 * `~/server/db/client` and the ClickHouse client, both of which run side effects at
 * import and drag `~/env/server` in behind them.
 */

import { Prisma } from '@prisma/client';
import pLimit from 'p-limit';
import { CacheTTL } from '~/server/common/constants';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { withSpan } from '~/server/utils/otel-helpers';
import { CollectionItemStatus, ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * An error whose message is safe to show the caller — a misconfiguration or a bad
 * request, never a query failure. Everything else is logged and replaced with a
 * generic message, because the ClickHouse `$query` wrapper appends the generated
 * SQL (id lists included) to the errors it throws.
 */
export class ContestScoringError extends Error {}

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
 * Two windows, and the difference decides prizes.
 *
 * `start`/`end` are the DISPLAY window a moderator drives from the date pickers — a
 * lens over the traffic being counted, freely narrowed to look at a single day.
 *
 * `contestStart`/`contestEnd` are the contest itself, off the collection's metadata.
 * Anything that decides ELIGIBILITY reads these: the age gate, and which versions
 * qualify. Narrowing the view must never make an entry ineligible, only quieter.
 */
export type ResolvedWindow = {
  start: Date;
  end: Date;
  /** `end` clamped to now. A contest still running is scored up to this instant. */
  effectiveEnd: Date;
  /** True while the contest is still open — the run is a preview, not a result. */
  partial: boolean;
  ageCutoff: Date;
  contestStart: Date;
  contestEnd: Date;
  contestStartSource: ContestBoundSource;
  contestEndSource: ContestBoundSource;
  /** `Collection.metadata.baseModels` — the rule entrants were actually told. */
  declaredBaseModels: string[];
};

/** Which field an eligibility bound came from, so a run can say so rather than imply it. */
export type ContestBoundSource =
  | 'submissionStartDate'
  | 'submissionEndDate'
  | 'endsAt'
  | 'collectionCreatedAt';

// Raised from 1000 after a past contest (collection 3991102) came in at 1138 accepted
// items — the old ceiling was already reachable, and a category that loses entries has
// to have its ranks withheld because the normalization maxima come from survivors.
const MAX_ENTRIES = 5000;

// Entities per ClickHouse call. Chunks are cut along ENTRY boundaries, never entity
// ones: uniqExact cannot be summed across chunks, so every entity belonging to an
// entry has to be counted in the same call.
//
// The ceiling is the query TEXT, not the row count: `chPairTable` inlines every pair
// as a tuple literal, and the cluster caps a query at 262,144 bytes / 50,000 AST
// elements. The measured limit is ~8,000 four-element tuples; 5,000 leaves headroom.
const CH_ENTITY_CHUNK = 5000;

const CH_CONCURRENCY = 4;

export const DEFAULT_STATUSES: CollectionItemStatus[] = [CollectionItemStatus.ACCEPTED];

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

type BaseGates = {
  userIdThreshold: number;
  ageGateBandUsers: number;
  baseDisqualifiedIds: number[];
};

export type Gates = BaseGates & {
  /** Base list plus the banned/deleted engagers resolved for THIS contest. */
  disqualifiedIds: number[];
  /** Set when the engager set blew the cap and the ban refinement was skipped. */
  bannedRefinementSkipped: boolean;
  engagerCount: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
// Progressively widened until a registration is found. Civitai takes thousands of
// signups a day, so the first bound effectively always hits; the rest exist so the
// answer is correct rather than convenient.
const AGE_THRESHOLD_WINDOW_DAYS = [1, 7, 30];

/**
 * The lowest `User.id` registered after `cutoff`, optionally within a bounded window.
 *
 * `MATERIALIZED` is doing the work. `User` carries a PARTIAL index —
 * `User_createdAt_idx ON "User"("createdAt") WHERE "deletedAt" IS NULL` — which a
 * query omitting the `deletedAt` predicate cannot use at all; and even with the
 * predicate, `min(id)` tempts the planner into an ascending primary-key walk that
 * discards ~12.7M rows before its first match. Forcing the candidate set to
 * materialize off the index first turns that walk into a range scan.
 *
 * `deletedAt IS NULL` is safe here and the reasoning is not obvious. Skipping
 * soft-deleted rows can only RAISE `min(id)`, so the threshold can only get more
 * permissive — but every id in the resulting gap belongs, by definition, to a deleted
 * account, and deleted accounts are already disqualified by the ban/delete rule. The
 * gate is unchanged in effect.
 *
 * The one exception worth knowing: when the engager set blows `maxEngagers` that
 * ban/delete refinement is SKIPPED, and in that degraded path a soft-deleted account
 * in the gap would be admitted where the unfiltered query would have caught it via
 * the age gate. Such a run is already flagged `bannedRefinementSkipped` and told not
 * to decide a prize. The Postgres-side signals join `User` and check the ban columns
 * inline, so they are unaffected either way.
 */
async function lowestUserIdAfter(cutoff: Date, windowDays: number | null) {
  const upperBound =
    windowDays === null
      ? Prisma.empty
      : Prisma.sql`AND u."createdAt" < ${utc(new Date(cutoff.getTime() + windowDays * DAY_MS))}`;

  const [row] = await dbRead.$queryRaw<{ minId: number | null }[]>`
    WITH candidates AS MATERIALIZED (
      SELECT u.id
      FROM "User" u
      WHERE u."createdAt" > ${utc(cutoff)}
        ${upperBound}
        AND u."deletedAt" IS NULL
    )
    SELECT min(id)::int AS "minId" FROM candidates
  `;

  return row?.minId ?? null;
}

/**
 * `User.id` is autoincrement but NOT strictly monotonic with `createdAt` — at least
 * one backdated system account exists. `max(id) WHERE createdAt <= cutoff` would let
 * that single row drag the threshold up and wave through every account registered
 * since. `min(id) WHERE createdAt > cutoff` minus one can only ever be too strict,
 * which is the safe direction for an anti-cheat gate.
 *
 * The answer is a pure function of the cutoff and effectively immutable (a later
 * registration always has both a higher id and a later `createdAt`), so it stays
 * cached for a week — that is now a cheap miss rather than a painful one.
 */
async function loadAgeThreshold(ageCutoff: Date) {
  const key = `${
    REDIS_KEYS.CACHES.CONTEST_COMMUNITY_SCORE
  }:age-threshold:${ageCutoff.toISOString()}` as RedisKeyTemplateCache;

  return fetchThroughCache(
    key,
    () =>
      withSpan('contest-score.age-threshold', async () => {
        let threshold: number | null = null;
        for (const windowDays of AGE_THRESHOLD_WINDOW_DAYS) {
          const minId = await lowestUserIdAfter(ageCutoff, windowDays);
          if (minId !== null) {
            threshold = minId - 1;
            break;
          }
        }

        if (threshold === null) {
          // Only an UNBOUNDED miss means nobody registered after the cutoff. Treating
          // an empty bounded window as "nobody" would COALESCE to max(id) and admit
          // every account on the site — the same silent fail-open the age-gate bound
          // exists to prevent.
          const unbounded = await lowestUserIdAfter(ageCutoff, null);
          if (unbounded !== null) threshold = unbounded - 1;
          else {
            const [{ maxId }] = await dbRead.$queryRaw<{ maxId: number }[]>`
              SELECT max(id)::int AS "maxId" FROM "User"
            `;
            threshold = maxId;
          }
        }

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
export async function loadBaseGates(ageCutoff: Date) {
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
export async function resolveBannedEngagers(engagerIds: number[]) {
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
export async function collectChEngagers(
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

export type EntryRow = {
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

export type EntryImage = {
  id: number;
  url: string;
  nsfwLevel: number;
  type: string;
  width: number | null;
  height: number | null;
};

/** Every id reaching raw SQL passes through here, so nothing downstream has to trust a caller. */
export function intList(values: number[]) {
  for (const value of values)
    if (!Number.isInteger(value)) throw new ContestScoringError('Expected integer identifiers');
  return values.join(',');
}

export type WindowInput = {
  collectionId: number;
  start?: Date;
  end?: Date;
  tagIds?: number[];
  statuses?: CollectionItemStatus[];
};

export async function loadEntries(input: WindowInput) {
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

/**
 * True per-category entry counts, unaffected by the cap. `loadEntries` cuts on
 * `ci.id`, so truncation drops the NEWEST entries and does so unevenly across
 * categories; without this the surviving rows would render a complete-looking 1..N
 * ranking whose normalization maxima came from survivors alone. Predicates are kept
 * in step with `loadEntries` — a divergence here would understate what was lost.
 */
export async function loadCategoryTotals(input: WindowInput) {
  const { collectionId, tagIds } = input;
  const statuses = input.statuses ?? DEFAULT_STATUSES;

  const rows = await withSpan(
    'contest-score.category-totals',
    () =>
      dbRead.$queryRaw<{ tagId: number | null; total: number }[]>`
      SELECT ci."tagId" AS "tagId", count(*)::int AS "total"
      FROM "CollectionItem" ci
      JOIN "Model" m ON m.id = ci."modelId"
      WHERE ci."collectionId" = ${collectionId}
        AND ci."modelId" IS NOT NULL
        AND ci.status = ANY(ARRAY[${Prisma.join(statuses)}]::"CollectionItemStatus"[])
        ${tagIds?.length ? Prisma.sql`AND ci."tagId" IN (${Prisma.join(tagIds)})` : Prisma.empty}
      GROUP BY ci."tagId"
    `
  );

  return new Map(rows.map((row) => [row.tagId, Number(row.total)]));
}

/** One representative image per model — the creator's own showcase post, in their order. */
export async function loadEntryImages(modelIds: number[]) {
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

export type SignalCount = { collectionItemId: number; rawUsers: number; qualifiedUsers: number };

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
export async function runChCounts(
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
export async function loadImagePairs(
  entries: EntryRow[],
  versionPairs: EntryPair[],
  window: ResolvedWindow
) {
  return withSpan(
    'contest-score.image-pairs',
    () =>
      dbRead.$queryRaw<{ entryId: number; imageId: number }[]>`
      SELECT DISTINCT e."entryId" AS "entryId", i.id AS "imageId"
      FROM ${pgEntryTable(entries)}
      JOIN ${pgVersionTable(versionPairs)} ON v."entryId" = e."entryId"
      JOIN "ImageResourceNew" ir ON ir."modelVersionId" = v."versionId"
      JOIN "Image" i ON i.id = ir."imageId"
      JOIN "Post" p ON p.id = i."postId"
      WHERE p."publishedAt" IS NOT NULL
        AND p."publishedAt" <= ${nowUtc}
        AND p."publishedAt" >= ${utc(window.start)}
        AND p."publishedAt" < ${utc(window.effectiveEnd)}
        AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
      ORDER BY "entryId", "imageId"
    `
  );
}

export async function countImageAuthors(
  entries: EntryRow[],
  versionPairs: EntryPair[],
  window: ResolvedWindow,
  gates: BaseGates
) {
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
      JOIN ${pgVersionTable(versionPairs)} ON v."entryId" = e."entryId"
      JOIN "ImageResourceNew" ir ON ir."modelVersionId" = v."versionId"
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

/**
 * The only signal that stays MODEL-level. A collect targets the model, never a
 * version, so there is nothing to scope it to; the window filter is all it gets.
 */
export async function countCollectors(
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

/**
 * The versions that actually represent an entry: created inside the CONTEST window,
 * publicly published, and — where the contest names any — built on one of its base
 * models.
 *
 * Contest rules let an already-existing model enter with a new version, so counting
 * every version of the model credits an entry with traffic its contest work never
 * earned — a fifteen-month-old sibling version can carry an entry to first place.
 *
 * Deliberately NOT "the latest version": a creator who iterates during the contest
 * has every in-window version count toward the same entry.
 *
 * `contestStart`/`contestEnd`, never the display window: a moderator narrowing the
 * date pickers to inspect one day must not thereby strip every entry of its
 * qualifying version and declare the whole contest ineligible.
 */
export async function loadQualifyingVersions(
  entries: EntryRow[],
  window: ResolvedWindow,
  baseModels: string[]
) {
  const versions = await withSpan(
    'contest-score.qualifying-versions',
    () =>
      dbRead.$queryRaw<{ id: number; modelId: number }[]>`
      SELECT mv.id AS "id", mv."modelId" AS "modelId"
      FROM "ModelVersion" mv
      WHERE mv."modelId" IN (${Prisma.join(entries.map((e) => e.modelId))})
        AND mv."createdAt" >= ${utc(window.contestStart)}
        AND mv."createdAt" < ${utc(window.contestEnd)}
        AND mv.status = ${ModelStatus.Published}::"ModelStatus"
        ${
          baseModels.length
            ? Prisma.sql`AND mv."baseModel" IN (${Prisma.join(baseModels)})`
            : Prisma.empty
        }
    `
  );

  const byModel = new Map<number, EntryRow[]>();
  for (const entry of entries) {
    const existing = byModel.get(entry.modelId);
    if (existing) existing.push(entry);
    else byModel.set(entry.modelId, [entry]);
  }

  const pairs: EntryPair[] = [];
  const countByEntry = new Map<number, number>(entries.map((e) => [e.collectionItemId, 0]));
  for (const version of versions)
    for (const entry of byModel.get(version.modelId) ?? []) {
      pairs.push({
        entityId: version.id,
        entryId: entry.collectionItemId,
        creatorId: entry.creatorId,
        addedById: entry.addedById ?? 0,
      });
      countByEntry.set(entry.collectionItemId, (countByEntry.get(entry.collectionItemId) ?? 0) + 1);
    }

  return { pairs, countByEntry };
}

/**
 * The qualifying versions as a Postgres lookup table, so the image-derived signals
 * resolve their images through exactly the version set the ClickHouse signals count.
 *
 * An empty set renders as a well-typed table of no rows rather than an empty `VALUES`
 * list, which is a syntax error. The guard belongs here: every call site joins against
 * this, so relying on each of them to remember is one edit away from a 500 on a
 * contest where nothing qualifies.
 */
function pgVersionTable(pairs: EntryPair[]) {
  if (!pairs.length)
    return Prisma.raw(`(SELECT NULL::int AS "entryId", NULL::int AS "versionId" WHERE false) AS v`);

  const values = pairs.map((p) => `(${intList([p.entryId, p.entityId])})`).join(',');
  return Prisma.raw(`(VALUES ${values}) AS v("entryId", "versionId")`);
}

export function toImagePairs(rows: { entryId: number; imageId: number }[], entries: EntryRow[]) {
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

export function requireClickhouse() {
  if (!clickhouse)
    throw new ContestScoringError('ClickHouse is not configured in this environment');
  return clickhouse;
}

type PerCreatorRow = {
  userId: number;
  creatorId: number;
  events: number;
  entries: number;
  ips: string[];
};

/** Same entry-boundary chunking as the scoring path — the query-text ceiling is identical. */
export async function runChPerCreator(
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

/**
 * The three ClickHouse signal sources, bound to a window. Each takes the entity id
 * list and returns a projection of `userId` + `entityId`; the qualification gates are
 * applied by `chCountQuery` around them.
 */
export function chSignalSources(window: ResolvedWindow) {
  return {
    reactors: (ids: string) => `
        SELECT toInt64(userId) AS userId, toInt64(entityId) AS entityId
        FROM reactions
        WHERE type = 'Image_Create'
          AND entityId IN (${ids})
          AND time >= ${chDateTime(window.start)} AND time < ${chDateTime(window.effectiveEnd)}
          AND userId != 0
      `,
    downloaders: (ids: string) => `
        SELECT toInt64(userId) AS userId, toInt64(modelVersionId) AS entityId
        FROM modelVersionEvents
        WHERE type = 'Download'
          AND modelVersionId IN (${ids})
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
}

/**
 * The candidate-report sources. Same events as the download and reaction signals but
 * carrying `ip`, which the scoring path deliberately never selects — this is the one
 * surface that legitimately reports user ids.
 */
export function chCandidateSources(window: ResolvedWindow) {
  return {
    downloads: (ids: string) => `
      SELECT toInt64(userId) AS userId, toInt64(modelVersionId) AS entityId, ip
      FROM modelVersionEvents
      WHERE type = 'Download'
        AND modelVersionId IN (${ids})
        AND time >= ${chDateTime(window.start)} AND time < ${chDateTime(window.effectiveEnd)}
        AND userId != 0
    `,
    reactions: (ids: string) => `
      SELECT toInt64(userId) AS userId, toInt64(entityId) AS entityId, ip
      FROM reactions
      WHERE type = 'Image_Create'
        AND entityId IN (${ids})
        AND time >= ${chDateTime(window.start)} AND time < ${chDateTime(window.effectiveEnd)}
        AND userId != 0
    `,
  };
}
