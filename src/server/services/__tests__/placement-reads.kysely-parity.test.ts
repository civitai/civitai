import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  countPendingPlacementsBySurface,
  countPlacements,
  getChapterPlacementTarget,
  getImagePlacementTarget,
  getModelPlacementTarget,
  getUserPlacementScore,
  listApprovedPlacementRows,
  listPlacementSpacesFor,
  listStickerPlacementRows,
  listUserSubscriptionRows,
} from '@civitai/db-queries/placement';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadParitySchema } from '~/server/db/__tests__/parity-schema';

/**
 * Parity gate for the placement/sticker read family behind `kysely-placement-reads`.
 *
 * Each Prisma read below is copied VERBATIM from the service it came from, and runs against the
 * same rows in the same database as its Kysely port. Where the service maps the row before using
 * it, both sides are compared after the SAME mapping, written once here, so what is pinned is the
 * value each consumer reads: counts as numbers, timestamps as UTC Dates, enums and JSON as decoded.
 * Which client each call site passes, and that the flag routes between them, is pinned in CI by
 * the placement-reads / sticker-placement-reads / free-placement-reads `.kysely-flag` tests.
 *
 * Opt-in via `KYSELY_PARITY_DATABASE_URL`, which must point at a THROWAWAY database: the suite
 * drops and recreates the `placement_parity` schema. It deliberately does NOT fall back to
 * `DATABASE_URL`.
 *
 *   docker run -d --rm --name pg-parity -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=parity \
 *     -p 54329:5432 postgres:17
 *   KYSELY_PARITY_DATABASE_URL=postgresql://postgres:postgres@localhost:54329/parity \
 *     pnpm vitest run --project unit src/server/services/__tests__/placement-reads.kysely-parity.test.ts
 */
const parityUrl = process.env.KYSELY_PARITY_DATABASE_URL;
const SCHEMA = 'placement_parity';

const schemaStatements = loadParitySchema(
  resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/placement-reads-parity-schema.sql')
);

const withSchema = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  return parsed.toString();
};

const byKey =
  <T>(key: (row: T) => string | number) =>
  (rows: T[]) =>
    [...rows].sort((a, b) => String(key(a)).localeCompare(String(key(b))));

// Distinct ids per table, and none equal to a count, price or other id.
const ALICE = 101;
const NAMELESS = 102;
const PLACER = 103;
const OWNER = 104;
const STRANGER = 105;
const IMAGE = 201;
const IMAGE_NAMELESS_NO_POST = 202;
const POST = 301;
const MODEL = 401;
const STORYLINE_OPEN = 501;
const STORYLINE_DONE = 502;
const STORYLINE_TAKEN_DOWN = 503;
const CHAPTER_POST_OPEN = 601;
const CHAPTER_POST_REMOVED = 602;
const CHAPTER_POST_DONE = 603;
const CHAPTER_POST_TAKEN_DOWN = 604;
const TARGET = 701;
const OTHER_TARGET = 702;
const MISSING = 999;
const DAY = new Date(Date.UTC(2026, 9, 23));

describe.skipIf(!parityUrl)('placement reads: Kysely returns exactly what Prisma returned', () => {
  const prisma = new PrismaClient({ datasourceUrl: parityUrl && withSchema(parityUrl) });
  const { db } = createKyselyClients<DB>({ connectionString: parityUrl, singleClient: true });
  const kysely = db.withSchema(SCHEMA);
  const t = (table: string) => `"${SCHEMA}"."${table}"`;

  beforeAll(async () => {
    for (const statement of schemaStatements) await prisma.$executeRawUnsafe(statement);

    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('User')} (id, username, meta) VALUES
        (${ALICE}, 'alice', '{"scores": {"total": 26000.7}}'),
        (${NAMELESS}, NULL, '{"scores": {"total": -3.5}}'),
        (${PLACER}, 'placer', '{}'),
        (${OWNER}, 'owner', NULL),
        (${STRANGER}, 'stranger', '{"scores": {"total": "not a number"}}')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Image')} (id, "userId", "postId", type) VALUES
        (${IMAGE}, ${ALICE}, ${POST}, 'video'),
        (${IMAGE_NAMELESS_NO_POST}, ${NAMELESS}, NULL, 'image')
    `);
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${t('Model')} (id, "userId") VALUES (${MODEL}, ${ALICE})`
    );
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Storyline')} (id, "userId", status, "tosViolation") VALUES
        (${STORYLINE_OPEN}, ${ALICE}, 'Ongoing', false),
        (${STORYLINE_DONE}, ${NAMELESS}, 'Complete', false),
        (${STORYLINE_TAKEN_DOWN}, ${ALICE}, 'Ongoing', true)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('StorylineChapter')} (id, "storylineId", "postId", "removedAt") VALUES
        (1, ${STORYLINE_OPEN}, ${CHAPTER_POST_OPEN}, NULL),
        (2, ${STORYLINE_OPEN}, ${CHAPTER_POST_REMOVED}, '2026-10-20 13:14:15.678'),
        (3, ${STORYLINE_DONE}, ${CHAPTER_POST_DONE}, NULL),
        (4, ${STORYLINE_TAKEN_DOWN}, ${CHAPTER_POST_TAKEN_DOWN}, NULL)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t(
        'PlacementSpace'
      )} (surface, "entityType", "entityId", mode, price, "freeSlots", settings) VALUES
        ('sticker', 'user', ${ALICE}, 'review', 900, 5, '{"mediaTypes": ["image"], "nested": {"a": [1, null]}}'),
        ('sticker', 'post', ${POST}, 'auto', NULL, NULL, '{}'),
        ('sticker', 'image', ${IMAGE}, 'off', 120, 0, 'null'),
        ('sticker', 'image', ${IMAGE_NAMELESS_NO_POST}, 'review', 1, 1, '{}'),
        ('remixGallery', 'user', ${ALICE}, 'review', 77, 2, '{}')
    `);
    // Distinct createdAt on every listed row, so the listing order is fully determined. Two rows
    // sit on the UTC day boundary of DAY, either side of it.
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t(
        'Placement'
      )} (id, surface, "targetType", "targetId", "ownerId", "placerId", data, status, amount, free, "createdAt") VALUES
        (1, 'sticker', 'image', ${TARGET}, ${OWNER}, ${PLACER}, '{"cosmeticId": 11, "x": 0.5}', 'approved', 300, false, '2026-10-01 00:00:05.000'),
        (2, 'sticker', 'image', ${TARGET}, ${OWNER}, ${PLACER}, '{"cosmeticId": 12}', 'pending', 0, true, '2026-10-22 23:59:59.999'),
        (3, 'sticker', 'image', ${TARGET}, ${OWNER}, ${STRANGER}, '{"cosmeticId": 13}', 'pending', 0, true, '2026-10-23 00:00:00.000'),
        (4, 'sticker', 'image', ${TARGET}, ${OWNER}, ${PLACER}, '{"cosmeticId": 14}', 'declined', 0, true, '2026-10-23 00:00:01.000'),
        (5, 'sticker', 'image', ${OTHER_TARGET}, ${STRANGER}, ${PLACER}, '{"cosmeticId": 15}', 'approved', 450, false, '2026-10-01 00:00:01.000'),
        (6, 'sticker', 'image', ${TARGET}, ${OWNER}, ${PLACER}, 'null', 'approved', 0, true, '2026-10-02 00:00:00.000'),
        (7, 'remixGallery', 'image', ${TARGET}, ${OWNER}, ${PLACER}, '{}', 'pending', 50, false, '2026-10-23 05:00:00.000'),
        (8, 'sticker', 'image', ${TARGET}, ${STRANGER}, ${OWNER}, '{"cosmeticId": 18}', 'pending', 80, false, '2026-10-03 00:00:00.000')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Product')} (id, active, name, description, metadata, provider) VALUES
        ('prod-gold', true, 'Gold', NULL, '{"tier": "gold", "monthlyBuzz": 5000}', 'Civitai'),
        ('prod-bronze', false, 'Bronze', 'old', '{"tier": "bronze"}', 'Paddle')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t(
        'Price'
      )} (id, "productId", active, currency, "unitAmount", interval, "intervalCount") VALUES
        ('price-gold', 'prod-gold', true, 'usd', 5000, 'month', 1),
        ('price-bronze', 'prod-bronze', true, 'usd', NULL, NULL, NULL)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t(
        'CustomerSubscription'
      )} (id, "userId", "buzzType", metadata, status, "priceId", "productId", "cancelAtPeriodEnd", "cancelAt", "canceledAt", "currentPeriodStart", "currentPeriodEnd", "createdAt", "endedAt") VALUES
        ('sub-active', ${ALICE}, 'yellow', '{}', 'active', 'price-gold', 'prod-gold', false, NULL, NULL, '2026-10-01 00:00:00.000', '2026-11-01 00:00:00.000', '2026-09-30 12:34:56.789', NULL),
        ('sub-incomplete', ${ALICE}, 'green', '{"renewalEmailSent": true}', 'incomplete', 'price-bronze', 'prod-bronze', true, '2026-11-01 00:00:00.000', '2026-10-05 00:00:00.000', '2026-10-01 00:00:00.000', '2026-11-01 00:00:00.000', '2026-10-01 00:00:00.000', NULL),
        ('sub-canceled', ${ALICE}, 'blue', '{}', 'canceled', 'price-gold', 'prod-gold', false, NULL, NULL, '2026-08-01 00:00:00.000', '2026-09-01 00:00:00.000', '2026-08-01 00:00:00.000', '2026-09-01 00:00:00.000'),
        ('sub-other-user', ${PLACER}, 'yellow', '{}', 'active', 'price-gold', 'prod-gold', false, NULL, NULL, '2026-10-01 00:00:00.000', '2026-11-01 00:00:00.000', '2026-10-01 00:00:00.000', NULL)
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.destroy();
  });

  describe('target lookups (placement-space.service resolve*Target)', () => {
    const viaPrismaImage = (imageId: number) =>
      prisma.image.findUnique({
        where: { id: imageId },
        select: {
          id: true,
          userId: true,
          postId: true,
          type: true,
          user: { select: { username: true } },
        },
      });

    it.each([
      ['with a post and a named owner', IMAGE],
      ['with no post and a nameless owner', IMAGE_NAMELESS_NO_POST],
    ])('an image %s maps to the same owner, post, media type and username', async (_, id) => {
      const [k, p] = await Promise.all([getImagePlacementTarget(kysely, id), viaPrismaImage(id)]);
      expect(p).not.toBeNull(); // positive control
      expect({
        ownerId: k!.userId,
        postId: k!.postId,
        type: k!.type,
        ownerUsername: k!.username ?? null,
      }).toStrictEqual({
        ownerId: p!.userId,
        postId: p!.postId,
        type: p!.type,
        ownerUsername: p!.user?.username ?? null,
      });
    });

    it('a missing image is absent on both', async () => {
      expect(await getImagePlacementTarget(kysely, MISSING)).toBeUndefined();
      expect(await viaPrismaImage(MISSING)).toBeNull();
    });

    it('a model maps to the same owner and username, and a missing one is absent on both', async () => {
      const viaPrisma = (modelId: number) =>
        prisma.model.findUnique({
          where: { id: modelId },
          select: { userId: true, user: { select: { username: true } } },
        });
      const [k, p] = await Promise.all([getModelPlacementTarget(kysely, MODEL), viaPrisma(MODEL)]);
      expect(p).not.toBeNull();
      expect({ ownerId: k!.userId, ownerUsername: k!.username ?? null }).toStrictEqual({
        ownerId: p!.userId,
        ownerUsername: p!.user?.username ?? null,
      });
      expect(await getModelPlacementTarget(kysely, MISSING)).toBeUndefined();
      expect(await viaPrisma(MISSING)).toBeNull();
    });

    const viaPrismaChapter = (postId: number) =>
      prisma.storylineChapter.findUnique({
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

    it.each([
      ['open', CHAPTER_POST_OPEN],
      ['removed (a UTC timestamp)', CHAPTER_POST_REMOVED],
      ['on a completed storyline with a nameless creator', CHAPTER_POST_DONE],
      ['on a taken-down storyline', CHAPTER_POST_TAKEN_DOWN],
    ])('a chapter %s reads the same storyline facts', async (_, postId) => {
      const [k, p] = await Promise.all([
        getChapterPlacementTarget(kysely, postId),
        viaPrismaChapter(postId),
      ]);
      expect(p).not.toBeNull();
      expect({
        removedAt: k!.removedAt,
        storyline: {
          id: k!.storylineId,
          userId: k!.storylineUserId,
          status: k!.storylineStatus,
          tosViolation: k!.storylineTosViolation,
          user: { username: k!.username },
        },
      }).toStrictEqual(p);
    });

    it('a removed chapter carries its removedAt as the same UTC instant', async () => {
      const k = await getChapterPlacementTarget(kysely, CHAPTER_POST_REMOVED);
      expect(k!.removedAt).toEqual(new Date('2026-10-20T13:14:15.678Z'));
    });

    it('a post that is not a chapter is absent on both', async () => {
      expect(await getChapterPlacementTarget(kysely, MISSING)).toBeUndefined();
      expect(await viaPrismaChapter(MISSING)).toBeNull();
    });
  });

  describe('listPlacementSpacesFor (resolvePlacementSpaceFor space rows)', () => {
    const viaPrisma = (surface: string, levels: { entityType: string; entityId: number }[]) =>
      prisma.placementSpace.findMany({
        where: { surface, OR: levels },
        select: { entityType: true, mode: true, price: true, freeSlots: true, settings: true },
      });
    const sorted = byKey((row: { entityType: string }) => row.entityType);

    it.each([
      [
        'every level set, JSON settings including a JSON null',
        'sticker',
        [
          { entityType: 'image', entityId: IMAGE },
          { entityType: 'post', entityId: POST },
          { entityType: 'user', entityId: ALICE },
        ],
        3,
      ],
      [
        'another surface on the same account',
        'remixGallery',
        [{ entityType: 'user', entityId: ALICE }],
        1,
      ],
      ['levels with no row', 'sticker', [{ entityType: 'user', entityId: STRANGER }], 0],
    ])('%s', async (_, surface, levels, expected) => {
      const [k, p] = await Promise.all([
        listPlacementSpacesFor(kysely, { surface, levels }),
        viaPrisma(surface, levels),
      ]);
      expect(p).toHaveLength(expected);
      expect(sorted(k)).toStrictEqual(sorted(p));
    });
  });

  describe('the counts', () => {
    // countPlacements is handed the SAME where object as Prisma, as the services do (one builder
    // per predicate), so what is compared is the translation, on real rows.
    const both = (where: Parameters<typeof countPlacements>[1]) =>
      Promise.all([
        countPlacements(kysely, where),
        prisma.placement.count({ where: where as never }),
      ]);

    it('the reserved-slot predicate counts the same, as a number', async () => {
      const [k, p] = await both({
        surface: 'sticker',
        targetType: 'image',
        targetId: TARGET,
        free: true,
        status: { in: ['pending', 'approved'] },
      });
      expect(p).toBe(3); // rows 2, 3, 6: pending and approved free rows on TARGET, not 4 (declined)
      expect(k).toBe(p);
    });

    it('the daily-allowance predicate counts the same on both sides of the UTC midnight', async () => {
      const counts: number[] = [];
      for (const [placerId, since] of [
        [PLACER, DAY],
        [PLACER, new Date(DAY.getTime() - 1)],
        [STRANGER, DAY],
      ] as const) {
        const [k, p] = await both({ placerId, free: true, createdAt: { gte: since } });
        expect(k).toBe(p);
        counts.push(k);
      }
      // Positive control that the boundary is seen: 23:59:59.999 is in the second window only, and
      // the 00:00:00.000 row is inside the third (gte).
      expect(counts).toEqual([1, 2, 1]);
    });

    it('the never-twice-here predicate counts the same, every status', async () => {
      const [k, p] = await both({
        placerId: PLACER,
        free: true,
        surface: 'sticker',
        targetType: 'image',
        targetId: TARGET,
      });
      expect(p).toBe(3); // rows 2, 4, 6
      expect(k).toBe(p);
    });

    it('an empty `in` counts 0 on both', async () => {
      const [k, p] = await both({ placerId: PLACER, status: { in: [] } });
      expect(p).toBe(0);
      expect(k).toBe(p);
    });
    it('countPendingPlacementsBySurface matches the pending-badge groupBy', async () => {
      const [k, p] = await Promise.all([
        countPendingPlacementsBySurface(kysely, OWNER),
        prisma.placement.groupBy({
          by: ['surface'],
          where: { ownerId: OWNER, status: 'pending' },
          _count: { _all: true },
        }),
      ]);
      const sorted = byKey((row: { surface: string }) => row.surface);
      expect(sorted(k)).toStrictEqual(
        sorted(p.map((row) => ({ surface: row.surface, count: row._count._all })))
      );
      expect(sorted(k)).toStrictEqual([
        { surface: 'remixGallery', count: 1 },
        { surface: 'sticker', count: 2 },
      ]);
    });
  });

  describe('getUserPlacementScore (placementPriceRange user score)', () => {
    const viaPrisma = (userId: number) =>
      prisma.$queryRawUnsafe<{ score: number | null }[]>(
        `SELECT floor((meta -> 'scores' ->> 'total')::numeric)::int AS score FROM ${t(
          'User'
        )} WHERE id = $1`,
        userId
      );

    it.each([
      ['a fractional total, floored', ALICE, 26000],
      ['a negative fractional total, floored down', NAMELESS, -4],
      ['no score', PLACER, null],
      ['a NULL meta', OWNER, null],
    ])('%s', async (_, userId, expected) => {
      const [k, p] = await Promise.all([getUserPlacementScore(kysely, userId), viaPrisma(userId)]);
      expect(k).toStrictEqual([{ score: expected }]);
      expect(k).toStrictEqual(p);
    });

    it('an unknown user is no row on both', async () => {
      expect(await getUserPlacementScore(kysely, MISSING)).toStrictEqual([]);
      expect(await viaPrisma(MISSING)).toStrictEqual([]);
    });

    it('a total that is not a number raises on both', async () => {
      await expect(getUserPlacementScore(kysely, STRANGER)).rejects.toThrow();
      await expect(viaPrisma(STRANGER)).rejects.toThrow();
    });
  });

  describe('listUserSubscriptionRows (getCapTier subscriptions)', () => {
    // userSubscriptionSelect and activeSubscriptionStatuses, verbatim from subscriptions.service.ts.
    const viaPrisma = (userId: number) =>
      prisma.customerSubscription.findMany({
        where: {
          userId,
          status: { notIn: ['canceled', 'incomplete_expired', 'past_due', 'unpaid'] },
        },
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
      });
    const sorted = byKey((row: { id: string }) => row.id);

    it('returns the same nested rows, dates, JSON, enum and nulls included, and drops the same statuses', async () => {
      const [k, p] = await Promise.all([
        listUserSubscriptionRows(kysely, {
          userId: ALICE,
          excludedStatuses: ['canceled', 'incomplete_expired', 'past_due', 'unpaid'],
        }),
        viaPrisma(ALICE),
      ]);
      expect(sorted(p).map((row) => row.id)).toEqual(['sub-active', 'sub-incomplete']);
      expect(sorted(k)).toStrictEqual(sorted(p));
    });

    it('reads no other user rows', async () => {
      const [k, p] = await Promise.all([
        listUserSubscriptionRows(kysely, {
          userId: PLACER,
          excludedStatuses: ['canceled', 'incomplete_expired', 'past_due', 'unpaid'],
        }),
        viaPrisma(PLACER),
      ]);
      expect(k.map((row) => row.id)).toEqual(['sub-other-user']);
      expect(k).toStrictEqual(p);
    });
  });

  describe('sticker listing reads (sticker-placement.service)', () => {
    // readStickerPlacementRows, verbatim.
    const viaPrismaListing = (imageIds: number[], viewerId?: number) =>
      prisma.placement.findMany({
        where: {
          surface: 'sticker',
          targetType: 'image',
          targetId: { in: imageIds },
          OR: [
            { status: 'approved' },
            ...(viewerId
              ? [
                  { status: 'pending' as const, placerId: viewerId },
                  { status: 'pending' as const, ownerId: viewerId },
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
      });

    it.each([
      ['the placer', PLACER, [5, 1, 6, 2]],
      ['the owner', OWNER, [5, 1, 6, 8, 2, 3]],
      ['a stranger to the pending rows', ALICE, [5, 1, 6]],
      ['signed out', undefined, [5, 1, 6]],
    ])('lists the same rows in the same order for %s', async (_, viewerId, ids) => {
      const input = {
        surface: 'sticker',
        targetType: 'image',
        targetIds: [TARGET, OTHER_TARGET],
        viewerId,
      };
      const [k, p] = await Promise.all([
        listStickerPlacementRows(kysely, input),
        viaPrismaListing([TARGET, OTHER_TARGET], viewerId),
      ]);
      expect(p.map((row) => row.id)).toEqual(ids);
      // Not sorted: the ORDER BY is part of the contract.
      expect(k).toStrictEqual(p);
    });

    it('the approved rows for the counts match, a JSON null data included', async () => {
      const viaPrisma = () =>
        prisma.placement.findMany({
          where: {
            surface: 'sticker',
            targetType: 'image',
            targetId: { in: [TARGET, OTHER_TARGET] },
            status: 'approved',
          },
          select: { id: true, targetId: true, status: true, data: true },
        });
      const [k, p] = await Promise.all([
        listApprovedPlacementRows(kysely, {
          surface: 'sticker',
          targetType: 'image',
          targetIds: [TARGET, OTHER_TARGET],
        }),
        viaPrisma(),
      ]);
      const sorted = byKey((row: { id: number }) => row.id);
      expect(sorted(p).map((row) => row.id)).toEqual([1, 5, 6]);
      expect(sorted(k)).toStrictEqual(sorted(p));
    });
  });
});
