import { Prisma } from '@prisma/client';
import { clickhouse } from '~/server/clickhouse/client';
import { BUG_CLOSED_STATUSES, CacheTTL, isBugClosed } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import type {
  CreateBugInput,
  DeleteBugInput,
  GetBugByIdInput,
  GetBugsInput,
  UpdateBugInput,
} from '~/server/schema/bug.schema';
import { cachedCounter } from '~/server/utils/cache-helpers';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
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

export const bugReportCounter = cachedCounter<number>(
  REDIS_KEYS.COUNTERS.BUG_REPORTS,
  async (bugId) => {
    if (!clickhouse) return 0;
    const rows = await clickhouse.$query<{ total: number }>`
      SELECT count() AS total FROM bugReports WHERE bugId = ${bugId}
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

export const getLatestBugUpdate = async (input?: { domain?: DomainColor }) => {
  const { domain } = input ?? {};
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
};

export const getBugStatusForReport = async (bugId: number) => {
  const bug = await dbRead.bug.findUnique({ where: { id: bugId }, select: { status: true } });
  return bug?.status ?? 'Unknown';
};

export { BUG_CLOSED_STATUSES };
