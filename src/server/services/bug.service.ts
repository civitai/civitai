import { Prisma } from '@prisma/client';
import { clickhouse } from '~/server/clickhouse/client';
import { BUG_CLOSED_STATUSES, CacheTTL, isBugClosed } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import type {
  CreateBugInput,
  DeleteBugInput,
  GetBugByIdInput,
  GetBugReportStatsInput,
  GetBugsInput,
  UpdateBugInput,
} from '~/server/schema/bug.schema';
import dayjs from '~/shared/utils/dayjs';
import { cachedCounter } from '~/server/utils/cache-helpers';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { createKeyedTtlMemo } from '~/server/utils/ttl-memoize';
import { DomainColor } from '~/shared/utils/prisma/enums';

const bugSelect = Prisma.validator<Prisma.BugSelect>()({
  id: true,
  title: true,
  summary: true,
  content: true,
  status: true,
  clickupUrl: true,
  firstSeenAt: true,
  resolvedAt: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  disabled: true,
  domain: true,
  tags: true,
});

type BugRow = Prisma.BugGetPayload<{ select: typeof bugSelect }>;
export type Bug = BugRow & { reportCount: number };

// Button counter: distinct reporters in the last 24h (rolling). The 1h TTL trims
// the trailing edge as reports age out; incrementBy keeps it live between refreshes.
// (The mod-only chart in getBugReportStats stays all-time.)
export const bugReportCounter = cachedCounter<number>(
  REDIS_KEYS.COUNTERS.BUG_REPORTS,
  async (bugId) => {
    if (!clickhouse) return 0;
    const rows = await clickhouse.$query<{ total: number }>`
      SELECT uniqExact(userId) AS total
      FROM bugReports
      WHERE bugId = ${bugId} AND createdAt >= now() - INTERVAL 24 HOUR
    `;
    return rows?.[0]?.total ?? 0;
  },
  { ttl: CacheTTL.hour }
);

const attachReportCounts = async <T extends { id: number }>(
  bugs: T[]
): Promise<(T & { reportCount: number })[]> => {
  const counts = await Promise.all(bugs.map((b) => bugReportCounter.get(b.id).catch(() => 0)));
  return bugs.map((b, i) => ({ ...b, reportCount: counts[i] ?? 0 }));
};

export const getBugs = async (input: GetBugsInput & { hasFeature: boolean }) => {
  const { hasFeature, limit, cursor, sortDir, search, statuses, includeClosed, tags, domain } =
    input;

  const where: Prisma.BugWhereInput = {
    domain: { hasSome: domain ? [DomainColor.all, domain] : [DomainColor.all] },
  };

  if (!hasFeature) {
    where.disabled = false;
    where.publishedAt = { lte: new Date(), not: null };
  }

  if (search && search.length > 0) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { summary: { contains: search, mode: 'insensitive' } },
      { content: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (statuses && statuses.length > 0) {
    where.status = { in: statuses, mode: 'insensitive' };
  } else if (!includeClosed) {
    where.resolvedAt = null;
  }

  if (tags && tags.length > 0) {
    where.tags = { hasSome: tags };
  }

  const skip = cursor ?? 0;

  try {
    const data = await dbRead.bug.findMany({
      select: bugSelect,
      where,
      take: limit + 1,
      skip,
      orderBy: [{ updatedAt: sortDir }, { id: sortDir }],
    });

    const hasMore = data.length > limit;
    if (hasMore) data.pop();

    const items = await attachReportCounts(data);

    return {
      items,
      nextCursor: hasMore ? skip + data.length : undefined,
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getBugById = async ({ id }: GetBugByIdInput) => {
  try {
    const bug = await dbRead.bug.findUnique({ where: { id }, select: bugSelect });
    if (!bug) throw throwNotFoundError(`Bug with id ${id} not found`);
    const [withCount] = await attachReportCounts([bug]);
    return withCount;
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) throw error;
    throw throwDbError(error);
  }
};

const applyResolvedAt = (status: string | undefined, current?: Date | null) => {
  if (status === undefined) return undefined;
  if (isBugClosed(status)) return current ?? new Date();
  return null;
};

export const createBug = async (data: CreateBugInput) => {
  try {
    const resolvedAt = isBugClosed(data.status) ? new Date() : null;
    return await dbWrite.bug.create({
      data: { ...data, resolvedAt },
      select: bugSelect,
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const updateBug = async (data: UpdateBugInput) => {
  const { id, status, ...rest } = data;
  try {
    const existing = await dbRead.bug.findUnique({
      where: { id },
      select: { status: true, resolvedAt: true },
    });
    if (!existing) throw throwNotFoundError(`Bug with id ${id} not found`);

    const resolvedAt =
      status !== undefined ? applyResolvedAt(status, existing.resolvedAt) : undefined;

    return await dbWrite.bug.update({
      where: { id },
      data: {
        ...rest,
        ...(status !== undefined ? { status } : {}),
        ...(resolvedAt !== undefined ? { resolvedAt } : {}),
      },
      select: bugSelect,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) throw error;
    throw throwDbError(error);
  }
};

export const deleteBug = async ({ id }: DeleteBugInput) => {
  try {
    return await dbWrite.bug.delete({ where: { id } });
  } catch (error) {
    throw throwDbError(error);
  }
};

// `getLatest` is a global-per-domain query (identical for every user of a given
// domain color) that the client polls on a 60s staleTime. It was previously an
// uncached dbRead.findFirst on EVERY call — one of the hottest uncached reads at
// peak. An in-proc (per-pod), per-domain TTL memo collapses that to ~1 DB read /
// domain / TTL / pod.
//
// Staleness: this in-proc TTL (CacheTTL.xs, 60s) STACKS on top of the existing
// edgeCacheIt({ ttl: CacheTTL.xs }) 60s CDN cache (+ staleWhileRevalidate 30s) on
// the resolver, so worst-case value age is ~2×TTL (~120s) rather than the edge
// TTL alone. Also, `new Date()` in the where-clause below is frozen for the memo
// window, so a scheduled / future-dated bug can surface up to ~TTL (~60s) late.
// Immaterial for minute-scale banner data. Fail-open: a DB error propagates
// uncached (see createKeyedTtlMemo), preserving the prior throw-on-error path.
const LATEST_BUG_UPDATE_INPROC_TTL_MS = CacheTTL.xs * 1000;

const getLatestBugUpdateMemo = createKeyedTtlMemo<number>(async (domainKey) => {
  const domain = domainKey ? (domainKey as DomainColor) : undefined;
  const bug = await dbRead.bug.findFirst({
    select: { updatedAt: true },
    where: {
      disabled: false,
      publishedAt: { lte: new Date(), not: null },
      resolvedAt: null,
      domain: { hasSome: domain ? [DomainColor.all, domain] : [DomainColor.all] },
    },
    orderBy: { updatedAt: 'desc' },
  });
  return !bug ? 0 : bug.updatedAt.getTime();
}, LATEST_BUG_UPDATE_INPROC_TTL_MS);

export const getLatestBugUpdate = async (input?: { domain?: DomainColor }) => {
  return getLatestBugUpdateMemo(input?.domain ?? '');
};

export const getBugStatusForReport = async (bugId: number) => {
  const bug = await dbRead.bug.findUnique({ where: { id: bugId }, select: { status: true } });
  return bug?.status ?? 'Unknown';
};

const BUG_REPORT_BUCKET_HOURS = 12;
const CH_BUCKET_FORMAT = 'YYYY-MM-DD HH:mm:ss';

export type BugReportPoint = { date: string; users: number };

// Floor a UTC dayjs to the same 12h boundaries ClickHouse's toStartOfInterval(..., 'UTC') uses.
const floorToBucket = (date: Date | string) => {
  const d = dayjs.utc(date);
  const hour = Math.floor(d.hour() / BUG_REPORT_BUCKET_HOURS) * BUG_REPORT_BUCKET_HOURS;
  return d.hour(hour).minute(0).second(0).millisecond(0);
};

// Distinct reporters bucketed every 12h, from each bug's firstSeenAt to now.
// Mod-only: surfaces whether reports are tapering off or still climbing.
export const getBugReportStats = async ({
  bugIds,
}: GetBugReportStatsInput): Promise<Record<number, BugReportPoint[]>> => {
  if (!clickhouse || bugIds.length === 0) return {};

  const bugs = await dbRead.bug.findMany({
    where: { id: { in: bugIds } },
    select: { id: true, firstSeenAt: true },
  });
  if (!bugs.length) return {};

  // Bound the scan to the earliest bucket we'll render so ClickHouse can prune partitions.
  const earliest = bugs.reduce(
    (min, b) => (b.firstSeenAt < min ? b.firstSeenAt : min),
    bugs[0].firstSeenAt
  );
  const since = floorToBucket(earliest).toDate();

  const ids = bugs.map((b) => b.id);
  const rows = await clickhouse.$query<{ bugId: number; bucket: string; users: string }>`
    SELECT
      bugId,
      toStartOfInterval(createdAt, INTERVAL ${BUG_REPORT_BUCKET_HOURS} HOUR, 'UTC') AS bucket,
      uniqExact(userId) AS users
    FROM bugReports
    WHERE bugId IN (${ids}) AND createdAt >= ${since}
    GROUP BY bugId, bucket
  `;

  // bugId -> CH bucket string -> distinct users
  const counts = new Map<number, Map<string, number>>();
  for (const row of rows) {
    const bugId = Number(row.bugId);
    if (!counts.has(bugId)) counts.set(bugId, new Map());
    counts.get(bugId)!.set(row.bucket, Number(row.users));
  }

  const now = dayjs.utc();
  const result: Record<number, BugReportPoint[]> = {};

  for (const bug of bugs) {
    const bugCounts = counts.get(bug.id) ?? new Map<string, number>();
    let cursor = floorToBucket(bug.firstSeenAt);

    const points: BugReportPoint[] = [];
    while (cursor.isBefore(now) || cursor.isSame(now)) {
      const key = cursor.format(CH_BUCKET_FORMAT);
      points.push({ date: cursor.toISOString(), users: bugCounts.get(key) ?? 0 });
      cursor = cursor.add(BUG_REPORT_BUCKET_HOURS, 'hour');
    }

    result[bug.id] = points;
  }

  return result;
};

export { BUG_CLOSED_STATUSES };
