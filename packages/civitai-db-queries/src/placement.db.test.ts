import { beforeEach, describe, expect, it } from 'vitest';
import {
  countFreePlacementsOnTarget,
  countFreePlacementsSince,
  countPendingPlacementsBySurface,
  countReservedFreeSlots,
  getChapterPlacementTarget,
  getImagePlacementTarget,
  getModelPlacementTarget,
  getUserPlacementScore,
  listApprovedPlacementRows,
  listPlacementSpacesFor,
  listStickerPlacementRows,
  listUserSubscriptionRows,
} from './placement.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

const only = () => {
  expect(harness.queries).toHaveLength(1);
  return harness.lastQuery();
};

// Pins the EXACT SQL and parameters. Parity with the Prisma reads these replace is pinned against a
// real database in src/server/services/__tests__/placement-reads.kysely-parity.test.ts. Every
// fixture value is distinct, so a swapped or hardcoded parameter shows in `parameters`.
describe('placement.db', () => {
  it('getImagePlacementTarget reads the image with its owner username in one statement', async () => {
    await getImagePlacementTarget(harness.db, 42);
    const { sql, parameters } = only();
    expect(sql).toBe(
      'select "Image"."id", "Image"."userId", "Image"."postId", "Image"."type", "User"."username" ' +
        'from "Image" left join "User" on "User"."id" = "Image"."userId" where "Image"."id" = $1'
    );
    expect(parameters).toEqual([42]);
  });

  it('getImagePlacementTarget resolves undefined, as a missing findUnique row', async () => {
    expect(await getImagePlacementTarget(harness.db, 42)).toBeUndefined();
  });

  it('getModelPlacementTarget reads the owner and username', async () => {
    await getModelPlacementTarget(harness.db, 43);
    const { sql, parameters } = only();
    expect(sql).toBe(
      'select "Model"."userId", "User"."username" from "Model" ' +
        'left join "User" on "User"."id" = "Model"."userId" where "Model"."id" = $1'
    );
    expect(parameters).toEqual([43]);
  });

  it('getChapterPlacementTarget reads the chapter, its storyline and the storyline creator', async () => {
    await getChapterPlacementTarget(harness.db, 44);
    const { sql, parameters } = only();
    expect(sql).toBe(
      'select "StorylineChapter"."removedAt", "Storyline"."id" as "storylineId", ' +
        '"Storyline"."userId" as "storylineUserId", "Storyline"."status" as "storylineStatus", ' +
        '"Storyline"."tosViolation" as "storylineTosViolation", "User"."username" ' +
        'from "StorylineChapter" ' +
        'inner join "Storyline" on "Storyline"."id" = "StorylineChapter"."storylineId" ' +
        'left join "User" on "User"."id" = "Storyline"."userId" ' +
        'where "StorylineChapter"."postId" = $1'
    );
    expect(parameters).toEqual([44]);
  });

  it('listPlacementSpacesFor matches each level as an (entityType, entityId) pair', async () => {
    await listPlacementSpacesFor(harness.db, {
      surface: 'sticker',
      levels: [
        { entityType: 'image', entityId: 11 },
        { entityType: 'post', entityId: 12 },
        { entityType: 'user', entityId: 13 },
      ],
    });
    const { sql, parameters } = only();
    expect(sql).toBe(
      'select "entityType", "mode", "price", "freeSlots", "settings" from "PlacementSpace" ' +
        'where "surface" = $1 and (("entityType" = $2 and "entityId" = $3) or ' +
        '("entityType" = $4 and "entityId" = $5) or ("entityType" = $6 and "entityId" = $7))'
    );
    expect(parameters).toEqual(['sticker', 'image', 11, 'post', 12, 'user', 13]);
  });

  it('listPlacementSpacesFor with no levels returns [] without a statement', async () => {
    expect(await listPlacementSpacesFor(harness.db, { surface: 'sticker', levels: [] })).toEqual(
      []
    );
    expect(harness.queries).toHaveLength(0);
  });

  it('countReservedFreeSlots counts free rows in the holding statuses on one space', async () => {
    await countReservedFreeSlots(harness.db, {
      surface: 'sticker',
      targetType: 'image',
      targetId: 21,
      statuses: ['pending', 'approved'],
    });
    const { sql, parameters } = only();
    expect(sql).toBe(
      'select count(*) as "count" from "Placement" where "surface" = $1 and "targetType" = $2 ' +
        'and "targetId" = $3 and "free" = $4 and "status" in ($5, $6)'
    );
    expect(parameters).toEqual(['sticker', 'image', 21, true, 'pending', 'approved']);
  });

  it('countReservedFreeSlots answers 0 with no statement for an empty status list', async () => {
    expect(
      await countReservedFreeSlots(harness.db, {
        surface: 'sticker',
        targetType: 'image',
        targetId: 21,
        statuses: [],
      })
    ).toBe(0);
    expect(harness.queries).toHaveLength(0); // `in ()` is a Postgres syntax error
  });

  it('countFreePlacementsSince bounds createdAt by the UTC instant, whatever the process zone', async () => {
    await countFreePlacementsSince(harness.db, {
      placerId: 31,
      since: new Date(Date.UTC(2026, 9, 23)),
    });
    const { sql, parameters } = only();
    expect(sql).toBe(
      'select count(*) as "count" from "Placement" where "placerId" = $1 and "free" = $2 ' +
        'and "createdAt" >= $3::timestamp'
    );
    expect(parameters).toEqual([31, true, '2026-10-23T00:00:00.000Z']);
  });

  it('countFreePlacementsOnTarget counts this placer free rows on one space, every status', async () => {
    await countFreePlacementsOnTarget(harness.db, {
      placerId: 32,
      surface: 'sticker',
      targetType: 'image',
      targetId: 33,
    });
    const { sql, parameters } = only();
    expect(sql).toBe(
      'select count(*) as "count" from "Placement" where "placerId" = $1 and "free" = $2 ' +
        'and "surface" = $3 and "targetType" = $4 and "targetId" = $5'
    );
    expect(parameters).toEqual([32, true, 'sticker', 'image', 33]);
  });

  it('the counts answer a JS number (0 when no row comes back)', async () => {
    expect(
      await countFreePlacementsOnTarget(harness.db, {
        placerId: 32,
        surface: 'sticker',
        targetType: 'image',
        targetId: 33,
      })
    ).toBe(0);
  });

  it('countPendingPlacementsBySurface groups one owner pending rows by surface', async () => {
    await countPendingPlacementsBySurface(harness.db, 41);
    const { sql, parameters } = only();
    expect(sql).toBe(
      'select "surface", count(*) as "count" from "Placement" where "ownerId" = $1 ' +
        'and "status" = $2 group by "surface"'
    );
    expect(parameters).toEqual([41, 'pending']);
  });

  it('getUserPlacementScore floors the stored total through numeric, as the raw query did', async () => {
    await getUserPlacementScore(harness.db, 51);
    const { sql, parameters } = only();
    expect(sql).toBe(
      'select floor((meta -> \'scores\' ->> \'total\')::numeric)::int as "score" from "User" ' +
        'where "id" = $1'
    );
    expect(parameters).toEqual([51]);
  });

  it('listUserSubscriptionRows reads the subscription with its product and price, excluding statuses', async () => {
    await listUserSubscriptionRows(harness.db, {
      userId: 61,
      excludedStatuses: ['canceled', 'unpaid'],
    });
    const { sql, parameters } = only();
    expect(sql).toBe(
      'select "s"."id", "s"."status", "s"."cancelAtPeriodEnd", "s"."cancelAt", "s"."canceledAt", ' +
        '"s"."currentPeriodStart", "s"."currentPeriodEnd", "s"."createdAt", "s"."endedAt", ' +
        '"s"."metadata", "s"."buzzType", ' +
        '"product"."id" as "productId", "product"."name" as "productName", ' +
        '"product"."description" as "productDescription", ' +
        '"product"."metadata" as "productMetadata", "product"."provider" as "productProvider", ' +
        '"product"."active" as "productActive", ' +
        '"price"."id" as "priceId", "price"."unitAmount" as "priceUnitAmount", ' +
        '"price"."interval" as "priceInterval", "price"."intervalCount" as "priceIntervalCount", ' +
        '"price"."currency" as "priceCurrency", "price"."active" as "priceActive" ' +
        'from "CustomerSubscription" as "s" ' +
        'inner join "Product" as "product" on "product"."id" = "s"."productId" ' +
        'inner join "Price" as "price" on "price"."id" = "s"."priceId" ' +
        'where "s"."userId" = $1 and "s"."status" not in ($2, $3)'
    );
    expect(parameters).toEqual([61, 'canceled', 'unpaid']);
  });

  it('listStickerPlacementRows lists approved rows plus the viewer pending ones, oldest first', async () => {
    await listStickerPlacementRows(harness.db, {
      surface: 'sticker',
      targetType: 'image',
      targetIds: [71, 72],
      viewerId: 73,
    });
    const { sql, parameters } = only();
    expect(sql).toBe(
      'select "id", "targetId", "placerId", "ownerId", "status", "amount", "free", "data", ' +
        '"createdAt" from "Placement" where "surface" = $1 and "targetType" = $2 ' +
        'and "targetId" in ($3, $4) and ("status" = $5 or ("status" = $6 and "placerId" = $7) ' +
        'or ("status" = $8 and "ownerId" = $9)) order by "createdAt" asc'
    );
    expect(parameters).toEqual([
      'sticker',
      'image',
      71,
      72,
      'approved',
      'pending',
      73,
      'pending',
      73,
    ]);
  });

  it('listStickerPlacementRows shows a signed-out viewer approved rows only', async () => {
    await listStickerPlacementRows(harness.db, {
      surface: 'sticker',
      targetType: 'image',
      targetIds: [71],
    });
    const { sql, parameters } = only();
    expect(sql).toBe(
      'select "id", "targetId", "placerId", "ownerId", "status", "amount", "free", "data", ' +
        '"createdAt" from "Placement" where "surface" = $1 and "targetType" = $2 ' +
        'and "targetId" in ($3) and "status" = $4 order by "createdAt" asc'
    );
    expect(parameters).toEqual(['sticker', 'image', 71, 'approved']);
  });

  it('listApprovedPlacementRows reads the approved rows the per-image count needs', async () => {
    await listApprovedPlacementRows(harness.db, {
      surface: 'sticker',
      targetType: 'image',
      targetIds: [81, 82],
    });
    const { sql, parameters } = only();
    expect(sql).toBe(
      'select "id", "targetId", "status", "data" from "Placement" where "surface" = $1 ' +
        'and "targetType" = $2 and "targetId" in ($3, $4) and "status" = $5'
    );
    expect(parameters).toEqual(['sticker', 'image', 81, 82, 'approved']);
  });

  it('the listing reads short-circuit an empty id list without a statement', async () => {
    const input = { surface: 'sticker', targetType: 'image', targetIds: [] };
    expect(await listStickerPlacementRows(harness.db, { ...input, viewerId: 73 })).toEqual([]);
    expect(await listApprovedPlacementRows(harness.db, input)).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });
});
