import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite, chQuery: vi.fn() }));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  clickhouse: { query: holder.chQuery },
}));

type Raw = ReturnType<typeof pgliteRaw>;
const toPglite = ((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never;
dbMock.dbRead.$queryRaw.mockImplementation(toPglite);
dbMock.dbWrite.$queryRaw.mockImplementation(toPglite);

const { getMyRemovedImages, REMOVED_IMAGES_LIMIT } = await import(
  '~/server/services/creator-removed-images.service'
);
const { getReportAgainstScore } = await import('~/server/jobs/update-user-score');
const { removalsQuery, withoutReversed } = await import(
  '~/server/services/creator-removals.service'
);
const { findPolicyChangeRemovals, insertRemovalScoreExemptions } = await import(
  '~/server/services/removal-score-exemption.service'
);

// The pg pool interface over the same PGlite database.
const pg = {
  cancellableQuery: async (sql: string, params?: unknown[]) => ({
    result: async () => (await holder.db.query(sql, params)).rows,
  }),
} as never;

const OWNER = 42;
const OTHER = 43; // whose only removal was reversed on appeal since the last run
const RESTORED_OWNER = 44; // whose only removal a restore event reversed since the last run
const SETTLED = 45; // whose removal was reversed on appeal before the last run, nothing since
const EXEMPT_OWNER = 46;
const REMOVED_AT = 1_700_000_000;
const LAST_RUN = REMOVED_AT + 86_400;
const at = (seconds: number) =>
  new Date(seconds * 1000).toISOString().slice(0, 23).replace('T', ' ');

// One owner, four removed images, as ClickHouse groups them (latest removal per image).
const RESTORED = 1; // removal reversed by an approved appeal
const STILL_REMOVED = 2; // no appeal
const REJECTED = 3; // appeal rejected
const REMOVED_AGAIN = 4; // approved, then removed again later
const EXEMPT = 7;
const REMOVED_AFTER_EXEMPTION = 8;
const POI_VERSION = 500;
const removals = [
  { ownerId: OWNER, imageId: REMOVED_AGAIN, removedAt: REMOVED_AT + 7200 },
  { ownerId: OWNER, imageId: RESTORED, removedAt: REMOVED_AT },
  { ownerId: OWNER, imageId: STILL_REMOVED, removedAt: REMOVED_AT },
  { ownerId: OWNER, imageId: REJECTED, removedAt: REMOVED_AT },
  { ownerId: OTHER, imageId: 5, removedAt: REMOVED_AT },
  { ownerId: SETTLED, imageId: 6, removedAt: REMOVED_AT },
  { ownerId: EXEMPT_OWNER, imageId: EXEMPT, removedAt: REMOVED_AT },
  { ownerId: EXEMPT_OWNER, imageId: REMOVED_AFTER_EXEMPTION, removedAt: LAST_RUN + 120 },
];
const ownRemovals = removals.filter((r) => r.ownerId === OWNER);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Model', 'Model3D');
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY, "userId" integer NOT NULL, "url" text NOT NULL DEFAULT '',
      "blockedFor" text, "needsReview" text
    );
    CREATE TABLE "Appeal" (
      "id" serial PRIMARY KEY, "userId" integer NOT NULL, "entityType" "EntityType" NOT NULL,
      "entityId" integer NOT NULL, "status" "AppealStatus" NOT NULL DEFAULT 'Pending',
      "resolvedAt" timestamp(3)
    );
    CREATE TABLE "RemovalScoreExemption" (
      "imageId" integer PRIMARY KEY, "reason" text NOT NULL,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(), "createdBy" integer
    );
    CREATE TABLE "Model" ("id" integer PRIMARY KEY, "poi" boolean NOT NULL DEFAULT false);
    CREATE TABLE "ModelVersion" ("id" integer PRIMARY KEY, "modelId" integer NOT NULL);
    INSERT INTO "Model" (id, poi) VALUES (1, true), (2, false);
    INSERT INTO "ModelVersion" (id, "modelId") VALUES (${POI_VERSION}, 1), (501, 2);
    CREATE TABLE "CsamReport" ("id" serial PRIMARY KEY, "userId" integer, "images" jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE "Report" ("id" serial PRIMARY KEY, "reason" text NOT NULL);
    CREATE TABLE "UserReport" ("userId" integer NOT NULL, "reportId" integer NOT NULL);
    -- Stands in for the hold-marker view; its definition is pinned against the real migration in
    -- remove-blocked-images-hold-guard.behavior.test.ts.
    CREATE TABLE "EvidenceHeldUser" ("userId" integer PRIMARY KEY, "heldUntil" timestamp(3));
    CREATE TABLE "EvidenceHoldImage" ("imageId" integer PRIMARY KEY, "userId" integer NOT NULL);
  `);
});

beforeEach(async () => {
  await holder.db.exec(
    `TRUNCATE "Image", "Appeal", "RemovalScoreExemption", "EvidenceHeldUser", "EvidenceHoldImage"`
  );
  await holder.db.exec(`
    INSERT INTO "Image" (id, "userId", "blockedFor") VALUES
      (${RESTORED}, ${OWNER}, NULL),
      (${STILL_REMOVED}, ${OWNER}, 'moderated'),
      (${REJECTED}, ${OWNER}, 'moderated'),
      (${REMOVED_AGAIN}, ${OWNER}, 'moderated'),
      (5, ${OTHER}, NULL),
      (6, ${SETTLED}, NULL),
      (${EXEMPT}, ${EXEMPT_OWNER}, NULL),
      (${REMOVED_AFTER_EXEMPTION}, ${EXEMPT_OWNER}, NULL);
    INSERT INTO "Appeal" ("userId", "entityType", "entityId", status, "resolvedAt") VALUES
      (${OWNER}, 'Image', ${RESTORED}, 'Approved', '${at(REMOVED_AT + 3600)}'),
      (${OWNER}, 'Image', ${REJECTED}, 'Rejected', '${at(REMOVED_AT + 3600)}'),
      (${OWNER}, 'Image', ${REMOVED_AGAIN}, 'Approved', '${at(REMOVED_AT + 3600)}'),
      (${OTHER}, 'Image', 5, 'Approved', '${at(LAST_RUN + 60)}'),
      (${SETTLED}, 'Image', 6, 'Approved', '${at(REMOVED_AT + 3600)}');
    INSERT INTO "RemovalScoreExemption" ("imageId", reason, "createdAt") VALUES
      (${EXEMPT}, 'test', '${at(LAST_RUN + 60)}'),
      (${REMOVED_AFTER_EXEMPTION}, 'test', '${at(REMOVED_AT + 3600)}');
  `);
  holder.chQuery.mockReset();
  holder.chQuery.mockResolvedValue({ json: async () => ownRemovals });
});

describe('the removed-images list', () => {
  it('leaves out a removal an approved appeal reversed, and keeps every other one', async () => {
    const result = await getMyRemovedImages(OWNER);

    expect(result.items.map((i) => i.imageId)).toEqual([REMOVED_AGAIN, STILL_REMOVED, REJECTED]);
    expect(result.total).toBe(3);
  });

  // A hold marker's kept image reads as a moderator block; listing it with an appeal link would
  // tell its owner something unusual is going on. The case above is the control.
  it('lists nothing, and so offers no appeal, to an owner under a hold marker', async () => {
    await holder.db.exec(`INSERT INTO "EvidenceHeldUser" ("userId") VALUES (${OWNER})`);

    const result = await getMyRemovedImages(OWNER);

    expect(result).toEqual({ total: 0, truncated: false, items: [] });
  });

  it('offers an appeal on a removed image no hold kept', async () => {
    const result = await getMyRemovedImages(OWNER);

    expect(result.items.find((i) => i.imageId === STILL_REMOVED)?.canAppeal).toBe(true);
  });

  // Once the hold ends the owner is no longer left out above, but the image it kept stays refused
  // by the appeal endpoint until it is purged or released. The case above is the control.
  it('lists an image a hold kept, after the hold ended, with no appeal', async () => {
    const before = await getMyRemovedImages(OWNER);
    await holder.db.exec(
      `INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES (${STILL_REMOVED}, ${OWNER})`
    );

    const result = await getMyRemovedImages(OWNER);

    expect(result.items.map((i) => [i.imageId, i.canAppeal])).toEqual(
      before.items.map((i) => [i.imageId, i.imageId === STILL_REMOVED ? false : i.canAppeal])
    );
  });

  it('still says it stopped at the limit when an appeal reversed one of those rows', async () => {
    const full = [
      ...ownRemovals,
      ...Array.from({ length: REMOVED_IMAGES_LIMIT - ownRemovals.length }, (_, i) => ({
        ownerId: OWNER,
        imageId: 1000 + i,
        removedAt: REMOVED_AT,
      })),
    ];
    holder.chQuery.mockResolvedValue({ json: async () => full });

    const result = await getMyRemovedImages(OWNER);

    expect(result.items.map((i) => i.imageId)).not.toContain(RESTORED);
    expect(result.truncated).toBe(true);
  });
});

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
// The ClickHouse SQL as it must read; the fake answers only these, so a changed query fails.
const REMOVALS_SQL = (owners: string) =>
  flat(`SELECT ownerId, imageId, toUnixTimestamp(maxIf(time, type = 'DeleteTOS')) AS removedAt
    FROM images WHERE type IN ('DeleteTOS', 'Restore') AND ownerId IN (${owners})
    GROUP BY ownerId, imageId
    HAVING maxIf(time, type = 'DeleteTOS') > maxIf(time, type = 'Restore')`);
const REMOVED_SINCE_SQL = flat(
  `SELECT DISTINCT ownerId FROM images WHERE type = 'DeleteTOS' AND time > ?`
);
const RESTORED_SINCE_SQL = flat(
  `SELECT DISTINCT ownerId FROM images WHERE type = 'Restore' AND time > ?`
);
const OWNERS_OF_SQL = (ids: string) =>
  flat(`SELECT DISTINCT ownerId FROM images WHERE type = 'DeleteTOS' AND imageId IN (${ids})`);

/**
 * Stands in for ClickHouse, which this suite cannot run: OWNER has a removal since the last run and
 * RESTORED_OWNER a restore event, whose removal the real query then drops (so `removals` has none).
 */
function fakeClickhouse() {
  const $query = vi.fn(async (query: TemplateStringsArray | string, ...values: unknown[]) => {
    // Interpolates as the real client does, with each date checked and shown as `?`.
    const text =
      typeof query === 'string'
        ? query
        : query.reduce((acc, part, i) => {
            if (i === 0) return part;
            const value = values[i - 1];
            if (value instanceof Date) expect(value).toEqual(new Date(LAST_RUN * 1000));
            return acc + (value instanceof Date ? '?' : String(value)) + part;
          }, '');
    const sql = flat(text);
    const owners = sql.match(/ownerId IN \(([\d,]+)\)/)?.[1];
    if (owners && sql === REMOVALS_SQL(owners))
      return removals.filter((r) => owners.split(',').map(Number).includes(r.ownerId));
    const ids = sql.match(/imageId IN \(([\d,]+)\)/)?.[1];
    if (ids && sql === OWNERS_OF_SQL(ids)) {
      const asked = ids.split(',').map(Number);
      const found = removals.filter((r) => asked.includes(r.imageId)).map((r) => r.ownerId);
      return [...new Set(found)].map((ownerId) => ({ ownerId }));
    }
    if (sql === REMOVED_SINCE_SQL) return [{ ownerId: OWNER }];
    if (sql === RESTORED_SINCE_SQL) return [{ ownerId: RESTORED_OWNER }];
    throw new Error(`unexpected query: ${sql}`);
  });
  return { $query };
}

async function scoreRun() {
  const scores = new Map<number, number>();
  await getReportAgainstScore({
    ch: fakeClickhouse() as never,
    lastUpdate: new Date(LAST_RUN * 1000),
    scoreMultipliers: { reportsAgainst: -1000 } as never,
    setScore: (id, category, score) => {
      expect(category).toBe('reportsAgainst');
      scores.set(id, score);
    },
  });
  return scores;
}

describe('a removal score exemption', () => {
  it('leaves an exempted removal off the list, and keeps one made after the exemption', async () => {
    const own = removals.filter((r) => r.ownerId === EXEMPT_OWNER);
    holder.chQuery.mockResolvedValue({ json: async () => own });

    const result = await getMyRemovedImages(EXEMPT_OWNER);

    expect(result.items.map((i) => i.imageId)).toEqual([REMOVED_AFTER_EXEMPTION]);
  });

  it('covers a removal made in the same instant as the exemption, and not one a second later', async () => {
    await holder.db.exec(
      `INSERT INTO "RemovalScoreExemption" ("imageId", reason, "createdAt") VALUES (20, 'test', '${at(
        REMOVED_AT
      )}')`
    );
    const removal = (removedAt: number) => [{ ownerId: EXEMPT_OWNER, imageId: 20, removedAt }];

    expect(await withoutReversed(removal(REMOVED_AT))).toEqual([]);
    expect(await withoutReversed(removal(REMOVED_AT + 1))).toHaveLength(1);
  });

  it('inserts each image once, keeping the reason of an earlier run', async () => {
    const inserted = await insertRemovalScoreExemptions(pg, [EXEMPT, 30], 'second run', 7);

    expect(inserted).toBe(1);
    const rows = await holder.db.query<{ imageId: number; reason: string; createdBy: number }>(
      `SELECT "imageId", reason, "createdBy" FROM "RemovalScoreExemption" WHERE "imageId" IN (${EXEMPT}, 30) ORDER BY 1`
    );
    expect(rows.rows).toEqual([
      { imageId: EXEMPT, reason: 'test', createdBy: null },
      { imageId: 30, reason: 'second run', createdBy: 7 },
    ]);
  });

  it('does not propose an image already exempted, even one removed again since', async () => {
    const policy = {
      cutoff: new Date(0),
      maxImageId: 100,
      ratings: ['None' as const],
      requireFirstRemovalAfterCutoff: true,
    };
    const history = (imageId: number, removedAt: number, resourceIds: number[] = []) => ({
      ownerId: EXEMPT_OWNER,
      imageId,
      removedAt,
      firstRemovedAt: removedAt,
      firstNsfw: 'None',
      firstReason: resourceIds.length ? '' : 'poi',
      lastReason: resourceIds.length ? '' : 'poi',
      resourceIds,
      minorRemovals: 0,
    });
    const ch = {
      $query: vi.fn(async () => [
        history(EXEMPT, REMOVED_AT),
        history(REMOVED_AFTER_EXEMPTION, LAST_RUN + 120),
        history(9, REMOVED_AT),
        history(10, REMOVED_AT, [POI_VERSION]), // made with a POI model's version
        history(11, REMOVED_AT, [501]), // made with another model's version
      ]),
    };

    const found = await findPolicyChangeRemovals(ch as never, pg, policy);

    expect(found.map((r) => r.imageId)).toEqual([9, 10]);
  });
});

describe('the Removed content score', () => {
  it('counts every removal but the one an approved appeal reversed', async () => {
    // Still removed, appeal rejected, and removed again after an approval: three of the four.
    expect((await scoreRun()).get(OWNER)).toBe(-3000);
  });

  it('re-scores, to zero, an owner whose appeal was approved since the last run', async () => {
    expect((await scoreRun()).get(OTHER)).toBe(0);
  });

  it('re-scores, to zero, an owner with a restore event since the last run', async () => {
    expect((await scoreRun()).get(RESTORED_OWNER)).toBe(0);
  });

  it('re-scores only owners with a removal or a reversal since the last run', async () => {
    expect([...(await scoreRun()).keys()].sort()).toEqual([
      OWNER,
      OTHER,
      RESTORED_OWNER,
      EXEMPT_OWNER,
    ]);
  });

  it('re-scores an owner exempted since the last run, counting only the removal made after its exemption', async () => {
    expect((await scoreRun()).get(EXEMPT_OWNER)).toBe(-1000);
  });

  it('reads approvals from the primary, not a lagging replica, to pick owners and to count', async () => {
    dbMock.dbWrite.$queryRaw.mockClear();
    dbMock.dbRead.$queryRaw.mockClear();
    await scoreRun();

    const reads = (mock: { mock: { calls: unknown[][] } }, predicate: string) =>
      mock.mock.calls.filter((c) => (c[0] as string[]).join('?').includes(predicate));
    const picking = '"resolvedAt" > ?';
    const counting = 'a."resolvedAt" > to_timestamp';
    expect(reads(dbMock.dbWrite.$queryRaw, picking)).toHaveLength(1);
    expect(reads(dbMock.dbWrite.$queryRaw, counting)).toHaveLength(1);
    expect(reads(dbMock.dbRead.$queryRaw, picking)).toHaveLength(0);
    expect(reads(dbMock.dbRead.$queryRaw, counting)).toHaveLength(0);
  });

  it('lets the member-facing list check appeals on the replica', async () => {
    dbMock.dbWrite.$queryRaw.mockClear();
    dbMock.dbRead.$queryRaw.mockClear();
    await getMyRemovedImages(OWNER);

    const counting = (c: unknown[]) => (c[0] as string[]).join('?').includes('to_timestamp');
    expect(dbMock.dbRead.$queryRaw.mock.calls.filter(counting)).toHaveLength(1);
    expect(dbMock.dbWrite.$queryRaw.mock.calls.filter(counting)).toHaveLength(0);
  });

  it('matches the list for the same owner', async () => {
    const listed = await getMyRemovedImages(OWNER);

    expect(Math.abs((await scoreRun()).get(OWNER)!)).toBe(listed.total * 1000);
  });

  it('reads removals through the SQL the fake answers, restore half included', () => {
    expect(flat(removalsQuery('ownerId IN (1)'))).toBe(REMOVALS_SQL('1'));
  });
});
