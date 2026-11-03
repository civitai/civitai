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
import { teamWaivedWhere } from '~/server/services/placement-count-predicates';
import { readTaggedGolden } from '~/server/db/__tests__/tagged-golden';

/**
 * The Kysely placement/sticker reads that replaced the Prisma ones behind the retired
 * `kysely-placement-reads` flag. Each must return, `toStrictEqual`, the value the Prisma read
 * returned for the same rows, after the SAME mapping the service applies: counts as numbers,
 * timestamps as UTC Dates, enums and JSON as decoded. Which client each call site passes is pinned by
 * the placement-reads / sticker-placement-reads / free-placement-reads `.kysely-flag` tests.
 *
 * Those values are fixtures/placement-reads-golden.json, printed by the Prisma reads (copied
 * verbatim from the services) against these same fixture rows in CI, before they were deleted. The
 * counts, scores and badge counts are small enough to be pinned inline. A change to the fixture rows
 * needs the golden re-derived by hand.
 *
 * Runs in CI: the `unit` job points KYSELY_HOT_READS_2_PARITY_DATABASE_URL at its throwaway Postgres
 * service, and the last test below fails if that wiring is lost. Locally, KYSELY_PARITY_DATABASE_URL
 * works too, and must point at a THROWAWAY database: the suite drops and recreates the
 * `placement_parity` schema. It deliberately does NOT fall back to `DATABASE_URL`.
 */
const parityUrl =
  process.env.KYSELY_HOT_READS_2_PARITY_DATABASE_URL ?? process.env.KYSELY_PARITY_DATABASE_URL;
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

const golden = readTaggedGolden(
  resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/placement-reads-golden.json')
);

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
    it.each([
      ['with a post and a named owner', IMAGE],
      ['with no post and a nameless owner', IMAGE_NAMELESS_NO_POST],
    ])('an image %s maps to the captured owner, post, media type and username', async (_, id) => {
      const k = await getImagePlacementTarget(kysely, id);
      expect({
        ownerId: k!.userId,
        postId: k!.postId,
        type: k!.type,
        ownerUsername: k!.username ?? null,
      }).toStrictEqual(golden.take(`image:${id}`));
    });

    it('a missing image is absent', async () => {
      expect(await getImagePlacementTarget(kysely, MISSING)).toBeUndefined();
    });

    it('a model maps to the captured owner and username, and a missing one is absent', async () => {
      const k = await getModelPlacementTarget(kysely, MODEL);
      expect({ ownerId: k!.userId, ownerUsername: k!.username ?? null }).toStrictEqual(
        golden.take(`model:${MODEL}`)
      );
      expect(await getModelPlacementTarget(kysely, MISSING)).toBeUndefined();
    });

    it.each([
      ['open', CHAPTER_POST_OPEN],
      ['removed (a UTC timestamp)', CHAPTER_POST_REMOVED],
      ['on a completed storyline with a nameless creator', CHAPTER_POST_DONE],
      ['on a taken-down storyline', CHAPTER_POST_TAKEN_DOWN],
    ])('a chapter %s reads the captured storyline facts', async (_, postId) => {
      const k = await getChapterPlacementTarget(kysely, postId);
      expect({
        removedAt: k!.removedAt,
        storyline: {
          id: k!.storylineId,
          userId: k!.storylineUserId,
          status: k!.storylineStatus,
          tosViolation: k!.storylineTosViolation,
          user: { username: k!.username },
        },
      }).toStrictEqual(golden.take(`chapter:${postId}`));
    });

    it('a removed chapter carries its removedAt as the same UTC instant', async () => {
      const k = await getChapterPlacementTarget(kysely, CHAPTER_POST_REMOVED);
      expect(k!.removedAt).toEqual(new Date('2026-10-20T13:14:15.678Z'));
    });

    it('a post that is not a chapter is absent', async () => {
      expect(await getChapterPlacementTarget(kysely, MISSING)).toBeUndefined();
    });
  });

  describe('listPlacementSpacesFor (resolvePlacementSpaceFor space rows)', () => {
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
      const k = await listPlacementSpacesFor(kysely, { surface, levels });
      expect(k).toHaveLength(expected);
      expect(sorted(k)).toStrictEqual(golden.take(`spaces:${_}`));
    });
  });

  describe('the counts', () => {
    // countPlacements is handed the Prisma-style where object the services build (one builder per
    // predicate, shared with the claim's in-lock Prisma counts), so what is pinned is the
    // translation, on real rows.
    const count = (where: Parameters<typeof countPlacements>[1]) => countPlacements(kysely, where);

    it('the reserved-slot predicate counts, as a number', async () => {
      const k = await count({
        surface: 'sticker',
        targetType: 'image',
        targetId: TARGET,
        free: true,
        status: { in: ['pending', 'approved'] },
      });
      expect(k).toBe(3); // rows 2, 3, 6: pending and approved free rows on TARGET, not 4 (declined)
    });

    it('the daily-allowance predicate counts on both sides of the UTC midnight', async () => {
      const counts: number[] = [];
      for (const [placerId, since] of [
        [PLACER, DAY],
        [PLACER, new Date(DAY.getTime() - 1)],
        [STRANGER, DAY],
      ] as const) {
        counts.push(await count({ placerId, free: true, createdAt: { gte: since } }));
      }
      // Positive control that the boundary is seen: 23:59:59.999 is in the second window only, and
      // the 00:00:00.000 row is inside the third (gte).
      expect(counts).toEqual([1, 2, 1]);
    });

    it('the never-twice-here predicate counts every status', async () => {
      const k = await count({
        placerId: PLACER,
        free: true,
        surface: 'sticker',
        targetType: 'image',
        targetId: TARGET,
      });
      expect(k).toBe(3); // rows 2, 4, 6
    });

    // Prisma's JSON path filter and its Kysely translation, on the same rows: a marked row, a row
    // marked otherwise, an empty object, a JSON null, and a paid row carrying the marker. Own ids,
    // so the counts above are untouched.
    it('the team-waived share counts the same on both sides, and only marked free rows', async () => {
      const WAIVER_PLACER = 106;
      const WAIVER_TARGET = 703;
      await prisma.$executeRawUnsafe(`
        INSERT INTO ${t(
          'Placement'
        )} (id, surface, "targetType", "targetId", "ownerId", "placerId", data, status, amount, free, "createdAt") VALUES
          (20, 'remixGallery', 'image', ${WAIVER_TARGET}, ${OWNER}, ${WAIVER_PLACER}, '{"imageId": 1, "waiver": "team"}', 'pending', 0, true, '2026-10-23 01:00:00.000'),
          (21, 'remixGallery', 'image', ${WAIVER_TARGET}, ${OWNER}, ${WAIVER_PLACER}, '{"imageId": 2, "waiver": "other"}', 'pending', 0, true, '2026-10-23 02:00:00.000'),
          (22, 'remixGallery', 'image', ${WAIVER_TARGET}, ${OWNER}, ${WAIVER_PLACER}, '{"imageId": 3}', 'pending', 0, true, '2026-10-23 03:00:00.000'),
          (23, 'remixGallery', 'image', ${WAIVER_TARGET}, ${OWNER}, ${WAIVER_PLACER}, 'null', 'pending', 0, true, '2026-10-23 04:00:00.000'),
          (24, 'remixGallery', 'image', ${WAIVER_TARGET}, ${OWNER}, ${WAIVER_PLACER}, '{"imageId": 5, "waiver": "team"}', 'pending', 50, false, '2026-10-23 05:00:00.000')
      `);
      try {
        const base = { placerId: WAIVER_PLACER, free: true, createdAt: { gte: DAY } };
        const counts = async (where: Parameters<typeof countPlacements>[1]) => [
          await prisma.placement.count({ where: where as never }),
          await count(where),
        ];
        expect(await counts(base)).toEqual([4, 4]);
        expect(await counts(teamWaivedWhere(base))).toEqual([1, 1]); // row 20 only
      } finally {
        await prisma.$executeRawUnsafe(`DELETE FROM ${t('Placement')} WHERE id BETWEEN 20 AND 24`);
      }
    });

    it('an empty `in` counts 0', async () => {
      expect(await count({ placerId: PLACER, status: { in: [] } })).toBe(0);
    });
    it('countPendingPlacementsBySurface counts the pending badges per surface', async () => {
      const k = await countPendingPlacementsBySurface(kysely, OWNER);
      const sorted = byKey((row: { surface: string }) => row.surface);
      expect(sorted(k)).toStrictEqual([
        { surface: 'remixGallery', count: 1 },
        { surface: 'sticker', count: 2 },
      ]);
    });
  });

  describe('getUserPlacementScore (placementPriceRange user score)', () => {
    it.each([
      ['a fractional total, floored', ALICE, 26000],
      ['a negative fractional total, floored down', NAMELESS, -4],
      ['no score', PLACER, null],
      ['a NULL meta', OWNER, null],
    ])('%s', async (_, userId, expected) => {
      expect(await getUserPlacementScore(kysely, userId)).toStrictEqual([{ score: expected }]);
    });

    it('an unknown user is no row', async () => {
      expect(await getUserPlacementScore(kysely, MISSING)).toStrictEqual([]);
    });

    it('a total that is not a number raises, as the Prisma raw query did', async () => {
      await expect(getUserPlacementScore(kysely, STRANGER)).rejects.toThrow();
    });
  });

  describe('listUserSubscriptionRows (getCapTier subscriptions)', () => {
    const sorted = byKey((row: { id: string }) => row.id);

    // activeSubscriptionStatuses.notIn, as getCapTier passes it.
    const excludedStatuses = ['canceled', 'incomplete_expired', 'past_due', 'unpaid'];

    it('returns the captured nested rows, dates, JSON, enum and nulls included, and drops the same statuses', async () => {
      const k = await listUserSubscriptionRows(kysely, { userId: ALICE, excludedStatuses });
      expect(sorted(k).map((row) => row.id)).toEqual(['sub-active', 'sub-incomplete']);
      expect(sorted(k)).toStrictEqual(golden.take(`subscriptions:${ALICE}`));
    });

    it('reads no other user rows', async () => {
      const k = await listUserSubscriptionRows(kysely, { userId: PLACER, excludedStatuses });
      expect(k.map((row) => row.id)).toEqual(['sub-other-user']);
      expect(k).toStrictEqual(golden.take(`subscriptions:${PLACER}`));
    });
  });

  describe('sticker listing reads (sticker-placement.service)', () => {
    it.each([
      ['the placer', PLACER, [5, 1, 6, 2]],
      ['the owner', OWNER, [5, 1, 6, 8, 2, 3]],
      ['a stranger to the pending rows', ALICE, [5, 1, 6]],
      ['signed out', undefined, [5, 1, 6]],
    ])('lists the captured rows in the captured order for %s', async (_, viewerId, ids) => {
      const k = await listStickerPlacementRows(kysely, {
        surface: 'sticker',
        targetType: 'image',
        targetIds: [TARGET, OTHER_TARGET],
        viewerId,
      });
      expect(k.map((row) => row.id)).toEqual(ids);
      // Not sorted: the ORDER BY is part of the contract.
      expect(k).toStrictEqual(golden.take(`stickers:${_}`));
    });

    it('the approved rows for the counts match, a JSON null data included', async () => {
      const k = await listApprovedPlacementRows(kysely, {
        surface: 'sticker',
        targetType: 'image',
        targetIds: [TARGET, OTHER_TARGET],
      });
      const sorted = byKey((row: { id: number }) => row.id);
      expect(sorted(k).map((row) => row.id)).toEqual([1, 5, 6]);
      expect(sorted(k)).toStrictEqual(golden.take('approved'));
    });
  });

  // Last in the suite: every captured case is still asserted above, so none can be dropped quietly.
  it('every golden case is asserted', () => {
    expect(golden.unused()).toEqual([]);
  });
});

// GitHub Actions only: the `unit` job there is the one wired with the database.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI: the parity database is wired', () => {
  expect(parityUrl).toBeTruthy();
});
