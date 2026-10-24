import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// The placement / sticker read family, ported from the Prisma reads in placement-space.service.ts,
// placement.service.ts, subscriptions.service.ts (getCapTier), free-placement.service.ts and
// sticker-placement.service.ts. Every function returns what the Prisma read returned after the
// caller's own mapping: counts as JS numbers, timestamps as UTC Dates (the pg parsers registered by
// @civitai/db/kysely), enums and JSON exactly as pg decodes them. Parity is pinned against a real
// database by <civitai>/src/server/services/__tests__/placement-reads.kysely-parity.test.ts.
//
// None of these may run inside the free-placement claim transaction: those counts decide under an
// advisory lock and stay on the Prisma `tx`.

/** The image a placement targets, with its owner's username (left join: null for a missing user). */
export function getImagePlacementTarget(db: Kysely<DB>, imageId: number) {
  return db
    .selectFrom('Image')
    .leftJoin('User', 'User.id', 'Image.userId')
    .select(['Image.id', 'Image.userId', 'Image.postId', 'Image.type', 'User.username'])
    .where('Image.id', '=', imageId)
    .executeTakeFirst();
}

export function getModelPlacementTarget(db: Kysely<DB>, modelId: number) {
  return db
    .selectFrom('Model')
    .leftJoin('User', 'User.id', 'Model.userId')
    .select(['Model.userId', 'User.username'])
    .where('Model.id', '=', modelId)
    .executeTakeFirst();
}

/** A chapter post and the storyline it belongs to. Inner join: the storyline relation is required. */
export function getChapterPlacementTarget(db: Kysely<DB>, postId: number) {
  return db
    .selectFrom('StorylineChapter')
    .innerJoin('Storyline', 'Storyline.id', 'StorylineChapter.storylineId')
    .leftJoin('User', 'User.id', 'Storyline.userId')
    .select([
      'StorylineChapter.removedAt',
      'Storyline.id as storylineId',
      'Storyline.userId as storylineUserId',
      'Storyline.status as storylineStatus',
      'Storyline.tosViolation as storylineTosViolation',
      'User.username',
    ])
    .where('StorylineChapter.postId', '=', postId)
    .executeTakeFirst();
}

/**
 * The space rows on one surface for a set of (entityType, entityId) levels. Unordered, as the
 * source was: the caller finds each level by `entityType`, and (surface, entityType, entityId) is
 * unique.
 */
export async function listPlacementSpacesFor(
  db: Kysely<DB>,
  input: { surface: string; levels: { entityType: string; entityId: number }[] }
) {
  if (!input.levels.length) return [];
  return db
    .selectFrom('PlacementSpace')
    .select(['entityType', 'mode', 'price', 'freeSlots', 'settings'])
    .where('surface', '=', input.surface)
    .where((eb) =>
      eb.or(
        input.levels.map((level) =>
          eb.and([eb('entityType', '=', level.entityType), eb('entityId', '=', level.entityId)])
        )
      )
    )
    .execute();
}

const countOf = (row: { count: string | number | bigint } | undefined) => Number(row?.count ?? 0);

/** Free placements on one space whose status still holds a slot. */
export async function countReservedFreeSlots(
  db: Kysely<DB>,
  input: {
    surface: string;
    targetType: string;
    targetId: number;
    statuses: readonly string[];
  }
) {
  if (!input.statuses.length) return 0;
  return countOf(
    await db
      .selectFrom('Placement')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('surface', '=', input.surface)
      .where('targetType', '=', input.targetType)
      .where('targetId', '=', input.targetId)
      .where('free', '=', true)
      .where('status', 'in', [...input.statuses])
      .executeTakeFirst()
  );
}

/**
 * Free placements a placer has made since `since`, across every surface and status.
 *
 * `since` is sent as a UTC ISO string cast to `timestamp`: `createdAt` is `timestamp without time
 * zone` holding UTC, and pg serialises a Date parameter in the PROCESS time zone, whose offset
 * Postgres drops on that cast — so a bare Date would shift the window off UTC midnight anywhere the
 * process is not on UTC.
 */
export async function countFreePlacementsSince(
  db: Kysely<DB>,
  input: { placerId: number; since: Date }
) {
  return countOf(
    await db
      .selectFrom('Placement')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('placerId', '=', input.placerId)
      .where('free', '=', true)
      .where('createdAt', '>=', sql<Date>`${input.since.toISOString()}::timestamp`)
      .executeTakeFirst()
  );
}

export async function countFreePlacementsOnTarget(
  db: Kysely<DB>,
  input: { placerId: number; surface: string; targetType: string; targetId: number }
) {
  return countOf(
    await db
      .selectFrom('Placement')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('placerId', '=', input.placerId)
      .where('free', '=', true)
      .where('surface', '=', input.surface)
      .where('targetType', '=', input.targetType)
      .where('targetId', '=', input.targetId)
      .executeTakeFirst()
  );
}

/** Pending placements per surface for one owner. Counts are numbers, as Prisma's `_count` was. */
export async function countPendingPlacementsBySurface(db: Kysely<DB>, ownerId: number) {
  const rows = await db
    .selectFrom('Placement')
    .select((eb) => ['surface', eb.fn.countAll().as('count')])
    .where('ownerId', '=', ownerId)
    .where('status', '=', 'pending')
    .groupBy('surface')
    .execute();
  return rows.map((row) => ({ surface: row.surface, count: countOf(row) }));
}

/**
 * A user's creator score as the placement price range reads it. Rows, like the `$queryRaw` it
 * replaces: `[]` for an unknown user, `[{ score: null }]` for one with no score.
 */
export function getUserPlacementScore(db: Kysely<DB>, userId: number) {
  return db
    .selectFrom('User')
    .select(sql<number | null>`floor((meta -> 'scores' ->> 'total')::numeric)::int`.as('score'))
    .where('id', '=', userId)
    .execute();
}

/**
 * A user's subscriptions outside `excludedStatuses`, in the nested shape of the Prisma
 * `customerSubscription.findMany({ select: userSubscriptionSelect })` it replaces. Inner joins:
 * product and price are required relations.
 */
export async function listUserSubscriptionRows(
  db: Kysely<DB>,
  input: { userId: number; excludedStatuses: readonly string[] }
) {
  let query = db
    .selectFrom('CustomerSubscription as s')
    .innerJoin('Product as product', 'product.id', 's.productId')
    .innerJoin('Price as price', 'price.id', 's.priceId')
    .select([
      's.id',
      's.status',
      's.cancelAtPeriodEnd',
      's.cancelAt',
      's.canceledAt',
      's.currentPeriodStart',
      's.currentPeriodEnd',
      's.createdAt',
      's.endedAt',
      's.metadata',
      's.buzzType',
      'product.id as productId',
      'product.name as productName',
      'product.description as productDescription',
      'product.metadata as productMetadata',
      'product.provider as productProvider',
      'product.active as productActive',
      'price.id as priceId',
      'price.unitAmount as priceUnitAmount',
      'price.interval as priceInterval',
      'price.intervalCount as priceIntervalCount',
      'price.currency as priceCurrency',
      'price.active as priceActive',
    ])
    .where('s.userId', '=', input.userId);
  if (input.excludedStatuses.length)
    query = query.where('s.status', 'not in', [...input.excludedStatuses]);

  const rows = await query.execute();
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    cancelAt: row.cancelAt,
    canceledAt: row.canceledAt,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
    metadata: row.metadata,
    buzzType: row.buzzType,
    product: {
      id: row.productId,
      name: row.productName,
      description: row.productDescription,
      metadata: row.productMetadata,
      provider: row.productProvider,
      active: row.productActive,
    },
    price: {
      id: row.priceId,
      unitAmount: row.priceUnitAmount,
      interval: row.priceInterval,
      intervalCount: row.priceIntervalCount,
      currency: row.priceCurrency,
      active: row.priceActive,
    },
  }));
}

/**
 * The sticker listing rows: approved placements on these targets, plus pending ones the viewer is
 * the placer or the owner of. Ordered by `createdAt` ascending, as the source was.
 */
export async function listStickerPlacementRows(
  db: Kysely<DB>,
  input: { surface: string; targetType: string; targetIds: number[]; viewerId?: number }
) {
  if (!input.targetIds.length) return [];
  const { viewerId } = input;
  return db
    .selectFrom('Placement')
    .select([
      'id',
      'targetId',
      'placerId',
      'ownerId',
      'status',
      'amount',
      'free',
      'data',
      'createdAt',
    ])
    .where('surface', '=', input.surface)
    .where('targetType', '=', input.targetType)
    .where('targetId', 'in', input.targetIds)
    .where((eb) =>
      eb.or([
        eb('status', '=', 'approved'),
        ...(viewerId
          ? [
              eb.and([eb('status', '=', 'pending'), eb('placerId', '=', viewerId)]),
              eb.and([eb('status', '=', 'pending'), eb('ownerId', '=', viewerId)]),
            ]
          : []),
      ])
    )
    .orderBy('createdAt', 'asc')
    .execute();
}

/** Approved placements on these targets, for the per-image counts. Unordered, as the source was. */
export async function listApprovedPlacementRows(
  db: Kysely<DB>,
  input: { surface: string; targetType: string; targetIds: number[] }
) {
  if (!input.targetIds.length) return [];
  return db
    .selectFrom('Placement')
    .select(['id', 'targetId', 'status', 'data'])
    .where('surface', '=', input.surface)
    .where('targetType', '=', input.targetType)
    .where('targetId', 'in', input.targetIds)
    .where('status', '=', 'approved')
    .execute();
}
