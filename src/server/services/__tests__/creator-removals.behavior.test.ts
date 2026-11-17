import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOVAL_SCORE_WINDOW_DAYS } from '~/shared/constants/creator-journey.constants';
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
const { getOwnersWithRemovals, getOwnersWithRemovalsAgedOutSince, removalsQuery, withoutReversed } =
  await import('~/server/services/creator-removals.service');
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
const AGING_OWNER = 47; // whose older removal left the six-month window since the last run
const REMOVED_AT = 1_700_000_000;
const LAST_RUN = REMOVED_AT + 86_400;
const DAY = 86_400;
const NOW = new Date((REMOVED_AT + 30 * DAY) * 1000); // the removals above are a month old
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
const windowStart = (now: Date) => new Date(now.getTime() - REMOVAL_SCORE_WINDOW_DAYS * DAY * 1000);
const AGED_OUT_AT = Math.floor(windowStart(NOW).getTime() / 1000) - DAY;
const removals = [
  { ownerId: AGING_OWNER, imageId: 60, removedAt: AGED_OUT_AT },
  { ownerId: AGING_OWNER, imageId: 61, removedAt: REMOVED_AT },
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
    `TRUNCATE "Image", "Appeal", "RemovalScoreExemption", "EvidenceHeldUser", "EvidenceHoldImage", "CsamReport"`
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
    const result = await getMyRemovedImages(OWNER, NOW);

    expect(result.items.map((i) => i.imageId)).toEqual([REMOVED_AGAIN, STILL_REMOVED, REJECTED]);
    expect(result.total).toBe(3);
  });

  // A hold marker's kept image reads as a moderator block; an appeal link on it would tell its
  // owner something unusual is going on. The case above is the control.
  it('lists the same removals to an owner under a hold marker, with no appeal', async () => {
    const before = await getMyRemovedImages(OWNER, NOW);
    await holder.db.exec(`INSERT INTO "EvidenceHeldUser" ("userId") VALUES (${OWNER})`);

    const held = await getMyRemovedImages(OWNER, NOW);

    expect(before.items.some((i) => i.canAppeal)).toBe(true);
    expect(held.items.map((i) => i.imageId)).toEqual(before.items.map((i) => i.imageId));
    expect(held.items.map((i) => i.canAppeal)).toEqual(held.items.map(() => false));
  });

  it('gives a held owner’s item exactly what an ordinary non-appealable item gets', async () => {
    // Blocked by a scan rather than a moderator: a state any owner can reach, and never appealable.
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'tos' WHERE id = ${REJECTED}`);
    const ordinary = (await getMyRemovedImages(OWNER, NOW)).items.find(
      (i) => i.imageId === REJECTED
    );
    await holder.db.exec(`INSERT INTO "EvidenceHeldUser" ("userId") VALUES (${OWNER})`);
    const held = (await getMyRemovedImages(OWNER, NOW)).items.find(
      (i) => i.imageId === STILL_REMOVED
    );

    expect(ordinary?.canAppeal).toBe(false);
    const comparable = (item: typeof held) => ({ ...item, imageId: 0, removedAt: null });
    expect(comparable(held)).toStrictEqual(comparable(ordinary));
  });

  it('lists an owner a CSAM report names as before the report, with no appeal', async () => {
    const before = await getMyRemovedImages(OWNER, NOW);
    await holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${OWNER})`);

    const after = await getMyRemovedImages(OWNER, NOW);

    expect(before.items.some((i) => i.canAppeal)).toBe(true);
    expect(after).toStrictEqual({
      ...before,
      items: before.items.map((i) => ({ ...i, canAppeal: false })),
    });
  });

  // A hold's kept image stays refused until it is purged or released, even after the hold ends.
  it('lists an image a hold kept, after the hold ended, with no appeal', async () => {
    const ALSO_REMOVED = 9;
    holder.chQuery.mockResolvedValue({
      json: async () => [
        ...ownRemovals,
        { ownerId: OWNER, imageId: ALSO_REMOVED, removedAt: REMOVED_AT },
      ],
    });
    await holder.db.exec(
      `INSERT INTO "Image" (id, "userId", "blockedFor") VALUES (${ALSO_REMOVED}, ${OWNER}, 'moderated')`
    );
    const canAppeal = async () =>
      Object.fromEntries(
        (await getMyRemovedImages(OWNER, NOW)).items.map((i) => [i.imageId, i.canAppeal])
      );

    const before = await canAppeal();
    expect(before[STILL_REMOVED]).toBe(true);
    expect(before[ALSO_REMOVED]).toBe(true);

    await holder.db.exec(
      `INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES (${STILL_REMOVED}, ${OWNER})`
    );

    // Only the kept image changes.
    expect(await canAppeal()).toEqual({ ...before, [STILL_REMOVED]: false });
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

    const result = await getMyRemovedImages(OWNER, NOW);

    expect(result.items.map((i) => i.imageId)).not.toContain(RESTORED);
    expect(result.truncated).toBe(true);
  });
});

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
// The ClickHouse SQL as it must read; the fake answers only these, so a changed query fails.
const REMOVALS_SQL = (owners: string) =>
  flat(`SELECT ownerId, imageId, toUnixTimestamp(maxIf(time, type = 'DeleteTOS')) AS removedAt,
    coalesce(
      nullIf(argMaxIf(violationType, time, type = 'DeleteTOS'), ''),
      argMaxIf(tosReason, time, type = 'DeleteTOS')
    ) AS reason
    FROM images WHERE type IN ('DeleteTOS', 'Restore') AND ownerId IN (${owners})
    GROUP BY ownerId, imageId
    HAVING maxIf(time, type = 'DeleteTOS') > maxIf(time, type = 'Restore')`);
const REMOVED_SINCE_SQL = flat(
  `SELECT DISTINCT ownerId FROM images WHERE type = 'DeleteTOS' AND time > ?`
);
const RESTORED_SINCE_SQL = flat(
  `SELECT DISTINCT ownerId FROM images WHERE type = 'Restore' AND time > ?`
);
const AGED_OUT_SQL = flat(`SELECT DISTINCT ownerId FROM images
  WHERE type IN ('DeleteTOS', 'Restore') AND time > ?
  GROUP BY ownerId, imageId
  HAVING maxIf(time, type = 'DeleteTOS') > maxIf(time, type = 'Restore')
    AND maxIf(time, type = 'DeleteTOS') > ? AND maxIf(time, type = 'DeleteTOS') <= ?`);
const OWNERS_OF_SQL = (ids: string) =>
  flat(`SELECT DISTINCT ownerId FROM images WHERE type = 'DeleteTOS' AND imageId IN (${ids})`);

/**
 * Stands in for ClickHouse, which this suite cannot run: OWNER has a removal since the last run and
 * RESTORED_OWNER a restore event, whose removal the real query then drops (so `removals` has none).
 */
type FakeRemoval = { ownerId: number; imageId: number; removedAt: number; reason?: string | null };
function fakeClickhouse(ownerRemovals: FakeRemoval[] = removals, now = NOW) {
  const $query = vi.fn(async (query: TemplateStringsArray | string, ...values: unknown[]) => {
    // Interpolates as the real client does, with each date checked and shown as `?`.
    const dates: Date[] = [];
    const text =
      typeof query === 'string'
        ? query
        : query.reduce((acc, part, i) => {
            if (i === 0) return part;
            const value = values[i - 1];
            if (value instanceof Date) dates.push(value);
            return acc + (value instanceof Date ? '?' : String(value)) + part;
          }, '');
    const sql = flat(text);
    if (sql === AGED_OUT_SQL) {
      // The window as it stood at the last run, up to the window as it stands now.
      const from = windowStart(new Date(LAST_RUN * 1000));
      expect(dates).toEqual([from, from, windowStart(now)]);
      return [{ ownerId: AGING_OWNER }];
    }
    for (const date of dates) expect(date).toEqual(new Date(LAST_RUN * 1000));
    const owners = sql.match(/ownerId IN \(([\d,]+)\)/)?.[1];
    if (owners && sql === REMOVALS_SQL(owners))
      return ownerRemovals.filter((r) => owners.split(',').map(Number).includes(r.ownerId));
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

async function scoreRun(ch?: unknown, now = NOW) {
  const scores = new Map<number, number>();
  await getReportAgainstScore({
    ch: (ch ?? fakeClickhouse(removals, now)) as never,
    lastUpdate: new Date(LAST_RUN * 1000),
    now,
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

    const result = await getMyRemovedImages(EXEMPT_OWNER, NOW);

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

describe('the owners page of the retroactive pass', () => {
  it('asks for owners after the cursor, in id order, up to the limit, as whole numbers', async () => {
    const asked: string[] = [];
    const $query = async (sql: string) => {
      asked.push(sql);
      return [{ ownerId: 11 }];
    };

    const owners = await getOwnersWithRemovals({ $query } as never, 10.9, 2.7);

    expect(owners).toEqual([11]);
    const sql = flat(asked[0]);
    expect(sql).toContain('ownerId > 10 ORDER BY ownerId LIMIT 2');
    expect(sql).toContain("type = 'DeleteTOS'");
  });
});

describe('the nightly aged-out range', () => {
  const rangeOf = async (since: Date, now: Date) => {
    const asked: Date[][] = [];
    const ch = {
      $query: async (_q: TemplateStringsArray, ...values: unknown[]) => {
        asked.push(values.filter((v): v is Date => v instanceof Date));
        return [];
      },
    };
    await getOwnersWithRemovalsAgedOutSince(ch as never, since, now);
    // The query binds three dates: the range start twice (prune and lower bound), then its end.
    const [from, , to] = asked[0];
    return { from, to };
  };

  it('has no gap or overlap between consecutive runs across a month end', async () => {
    const aug30 = new Date('2024-08-30T01:00:00Z');
    const aug31 = new Date('2024-08-31T01:00:00Z');
    const sep1 = new Date('2024-09-01T01:00:00Z');

    const first = await rangeOf(aug30, aug31);
    const second = await rangeOf(aug31, sep1);

    expect(first.to).toEqual(second.from);
    expect(second.to.getTime() - second.from.getTime()).toBe(DAY * 1000);
  });
});

describe('the Removed content score', () => {
  const windowEndsAfter = (seconds: number) =>
    new Date((seconds + REMOVAL_SCORE_WINDOW_DAYS * DAY) * 1000);

  it('stops counting a removal when its window has passed', async () => {
    const justInside = new Date(windowEndsAfter(REMOVED_AT).getTime() - 1000);
    expect((await scoreRun(undefined, justInside)).get(OWNER)).toBe(-3000);

    // The three removals made at REMOVED_AT age out; the one made two hours later still counts.
    const afterFirstThree = new Date(windowEndsAfter(REMOVED_AT).getTime() + 1000);
    expect((await scoreRun(undefined, afterFirstThree)).get(OWNER)).toBe(-1000);

    const afterAll = new Date(windowEndsAfter(REMOVED_AT + 7200).getTime() + 1000);
    expect((await scoreRun(undefined, afterAll)).get(OWNER)).toBe(0);
  });

  it('weighs each removal by the reason of its latest removal', async () => {
    const reasons = ['realPerson', 'fecalMatter', 'other', 'manual', null, 'spam'];
    const own = reasons.map((reason, i) => ({
      ownerId: OWNER,
      imageId: 200 + i,
      removedAt: REMOVED_AT,
      reason,
    }));
    const ch = fakeClickhouse(own);

    // 1 + 0.5 + 0 + 1 + 1 + 0.5
    expect((await scoreRun(ch)).get(OWNER)).toBe(-4000);
  });

  it('weighs a single half-weight removal at half the penalty', async () => {
    const ch = fakeClickhouse([
      { ownerId: OWNER, imageId: 300, removedAt: REMOVED_AT, reason: 'diaper' },
    ]);

    expect((await scoreRun(ch)).get(OWNER)).toBe(-500);
  });

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
      AGING_OWNER,
    ]);
  });

  it('re-scores an owner whose removal left the window since the last run, keeping the newer one', async () => {
    expect((await scoreRun()).get(AGING_OWNER)).toBe(-1000);
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
    await getMyRemovedImages(OWNER, NOW);

    const counting = (c: unknown[]) => (c[0] as string[]).join('?').includes('to_timestamp');
    expect(dbMock.dbRead.$queryRaw.mock.calls.filter(counting)).toHaveLength(1);
    expect(dbMock.dbWrite.$queryRaw.mock.calls.filter(counting)).toHaveLength(0);
  });

  it('lists exactly the removals that cost points, and its owner pays for them', async () => {
    const own = [
      { ownerId: OWNER, imageId: 400, removedAt: REMOVED_AT, reason: 'realPerson' },
      { ownerId: OWNER, imageId: 401, removedAt: REMOVED_AT, reason: 'spam' },
      { ownerId: OWNER, imageId: 402, removedAt: REMOVED_AT, reason: 'other' }, // costs nothing
      { ownerId: OWNER, imageId: 403, removedAt: AGED_OUT_AT, reason: 'realPerson' }, // aged out
      { ownerId: OWNER, imageId: 404, removedAt: REMOVED_AT, reason: ' other ' }, // padded, costs nothing
    ];
    // ClickHouse leaves out the aged-out and cost-free rows itself; read its filters off the query.
    holder.chQuery.mockImplementation(async ({ query, query_params }) => {
      const excluded: string[] =
        (/NOT IN \(([^)]*)\)/.exec(query)?.[1] ?? '').match(/[^',\s]+/g) ?? [];
      // The query trims the reason as `removalWeight` does; an untrimmed match would list ' other '.
      const trims = query.includes("trimBoth(ifNull(reason, ''))");
      const json = own.filter((r) => {
        const reason = trims ? (r.reason ?? '').trim() : r.reason ?? '';
        expect(Number.isInteger(query_params.windowStart)).toBe(true);
        const inWindow =
          !query.includes('removedAt > {windowStart:Int64}') ||
          r.removedAt > query_params.windowStart;
        return inWindow && !excluded.includes(reason);
      });
      return { json: async () => json };
    });
    await holder.db.exec(
      `INSERT INTO "Image" (id, "userId", "blockedFor") VALUES
        (400, ${OWNER}, 'moderated'), (401, ${OWNER}, 'moderated'),
        (402, ${OWNER}, 'moderated'), (403, ${OWNER}, 'moderated'), (404, ${OWNER}, 'moderated')`
    );

    const listed = await getMyRemovedImages(OWNER, NOW);
    const score = (await scoreRun(fakeClickhouse(own))).get(OWNER)!;

    expect(listed.items.map((i) => i.imageId)).toEqual([400, 401]);
    expect(listed.total).toBe(2);
    expect(score).toBe(-1500);
  });

  it('matches the list for the same owner', async () => {
    const listed = await getMyRemovedImages(OWNER, NOW);

    expect(Math.abs((await scoreRun()).get(OWNER)!)).toBe(listed.total * 1000);
  });

  it('reads removals through the SQL the fake answers, restore half included', () => {
    expect(flat(removalsQuery('ownerId IN (1)'))).toBe(REMOVALS_SQL('1'));
  });
});
