import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Module factories for `@civitai/db-queries/placement` and `@civitai/db-queries/hot-reads` that
 * answer each Kysely read from the shared Prisma `dbMock`, with the very call the retired Prisma read
 * made (same model, same client, same where/select). For service tests whose fixtures, often
 * stateful fakes, are written against `dbMock`: they keep testing their own logic without
 * re-describing every row as a Kysely row.
 *
 * What the real Kysely queries return for real rows is pinned elsewhere, against a database:
 * services/__tests__/placement-reads.kysely-parity.test.ts and hot-reads-2.kysely-parity.test.ts.
 * Which client each call site passes is pinned by the `*.kysely-flag.test.ts` routing tests.
 *
 *   vi.mock('@civitai/db-queries/placement', async () =>
 *     (await import('~/__tests__/mocks/kysely-reads-over-db-mock')).placementReadsOverDbMock()
 *   );
 */
export function placementReadsOverDbMock() {
  return {
    getImagePlacementTarget: async (_db: unknown, imageId: number) => {
      const image = await dbMock.dbWrite.image.findUnique({
        where: { id: imageId },
        select: {
          id: true,
          userId: true,
          postId: true,
          type: true,
          user: { select: { username: true } },
        },
      });
      return image
        ? {
            id: image.id,
            userId: image.userId,
            postId: image.postId,
            type: image.type,
            username: image.user?.username ?? null,
          }
        : undefined;
    },
    getModelPlacementTarget: async (_db: unknown, modelId: number) => {
      const model = await dbMock.dbWrite.model.findUnique({
        where: { id: modelId },
        select: { userId: true, user: { select: { username: true } } },
      });
      return model ? { userId: model.userId, username: model.user?.username ?? null } : undefined;
    },
    getChapterPlacementTarget: async (_db: unknown, postId: number) => {
      const chapter = await dbMock.dbWrite.storylineChapter.findUnique({
        where: { postId },
        select: {
          removedAt: true,
          storyline: {
            select: {
              id: true,
              userId: true,
              status: true,
              tosViolation: true,
              user: { select: { username: true } },
            },
          },
        },
      });
      return chapter
        ? {
            removedAt: chapter.removedAt,
            storylineId: chapter.storyline.id,
            storylineUserId: chapter.storyline.userId,
            storylineStatus: chapter.storyline.status,
            storylineTosViolation: chapter.storyline.tosViolation,
            username: chapter.storyline.user?.username ?? null,
          }
        : undefined;
    },
    listPlacementSpacesFor: (
      _db: unknown,
      { surface, levels }: { surface: string; levels: { entityType: string; entityId: number }[] }
    ) =>
      dbMock.dbWrite.placementSpace.findMany({
        where: { surface, OR: levels },
        select: { entityType: true, mode: true, price: true, freeSlots: true, settings: true },
      }),
    countPlacements: (_db: unknown, where: Record<string, unknown>) =>
      dbMock.dbRead.placement.count({ where }),
    countPendingPlacementsBySurface: async (_db: unknown, ownerId: number) =>
      (
        (await dbMock.dbRead.placement.groupBy({
          by: ['surface'],
          where: { ownerId, status: 'pending' },
          _count: { _all: true },
        })) as { surface: string; _count: { _all: number } }[]
      ).map((row) => ({ surface: row.surface, count: row._count._all })),
    getUserPlacementScore: (_db: unknown, userId: number) => dbMock.dbRead.$queryRaw`
    SELECT floor((meta -> 'scores' ->> 'total')::numeric)::int AS score
    FROM "User" WHERE id = ${userId}
  `,
    listUserSubscriptionRows: (
      _db: unknown,
      { userId, excludedStatuses }: { userId: number; excludedStatuses: string[] }
    ) =>
      dbMock.dbWrite.customerSubscription.findMany({
        where: { userId, status: { notIn: excludedStatuses } },
        select: {
          id: true,
          status: true,
          cancelAtPeriodEnd: true,
          cancelAt: true,
          canceledAt: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          createdAt: true,
          endedAt: true,
          metadata: true,
          buzzType: true,
          product: {
            select: {
              id: true,
              name: true,
              description: true,
              metadata: true,
              provider: true,
              active: true,
            },
          },
          price: {
            select: {
              id: true,
              unitAmount: true,
              interval: true,
              intervalCount: true,
              currency: true,
              active: true,
            },
          },
        },
      }),
    listStickerPlacementRows: (
      _db: unknown,
      {
        surface,
        targetType,
        targetIds,
        viewerId,
      }: { surface: string; targetType: string; targetIds: number[]; viewerId?: number }
    ) =>
      dbMock.dbRead.placement.findMany({
        where: {
          surface,
          targetType,
          targetId: { in: targetIds },
          OR: [
            { status: 'approved' },
            ...(viewerId
              ? [
                  { status: 'pending', placerId: viewerId },
                  { status: 'pending', ownerId: viewerId },
                ]
              : []),
          ],
        },
        select: {
          id: true,
          targetId: true,
          placerId: true,
          ownerId: true,
          status: true,
          amount: true,
          free: true,
          data: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    listApprovedPlacementRows: (
      _db: unknown,
      {
        surface,
        targetType,
        targetIds,
      }: { surface: string; targetType: string; targetIds: number[] }
    ) =>
      dbMock.dbRead.placement.findMany({
        where: { surface, targetType, targetId: { in: targetIds }, status: 'approved' },
        select: { id: true, targetId: true, status: true, data: true },
      }),
  };
}

/** `getImageThread` from `dbMock.dbRead.thread.findUnique`, as the retired Prisma lookup read it. */
export async function hotReadsOverDbMock() {
  const actual = await import('@civitai/db-queries/hot-reads');
  return {
    ...actual,
    getImageThread: async (_db: unknown, imageId: number) =>
      (await dbMock.dbRead.thread.findUnique({
        where: { imageId },
        select: { id: true, locked: true },
      })) ?? undefined,
  };
}

/**
 * `readUserCreatorViaKysely` from `dbMock.dbRead.user.findFirst` then `dbMock.dbRead.model.count`,
 * the two calls the retired Prisma creator-card read made. For tests of what is built around the
 * card (caching, busts); the card's own rows are pinned in hot-reads-2.kysely-parity.test.ts.
 */
export async function userCreatorReadsOverDbMock() {
  const actual = await import('~/server/services/user-creator.reads');
  return {
    ...actual,
    readUserCreatorViaKysely: async (_db: unknown, where: { id?: number; username?: string }) => {
      const user = await dbMock.dbRead.user.findFirst({
        where: {
          ...where,
          deletedAt: null,
          AND: [{ id: { not: -1 } }, { username: { not: 'civitai' } }],
        },
      });
      if (!user) return null;
      const modelCount = await dbMock.dbRead.model.count({
        where: { userId: user.id, status: 'Published' },
      });
      return { user, modelCount };
    },
  };
}
