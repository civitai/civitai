import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { ImageIngestionStatus, ServiceOfferingIngestionStatus } from '~/shared/utils/prisma/enums';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * A service offering's rating and whether it may be shown. The rating recompute runs its real SQL
 * on an in-process Postgres with the real migrations; the storefront filter is evaluated against
 * rows; the moderation adapter's writes are applied to an in-memory row.
 */

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const report = vi.hoisted(() => ({ createReport: vi.fn(async () => ({ id: 1 })) }));
vi.mock('~/server/services/report.service', () => report);
const notifications = vi.hoisted(() => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock('~/server/services/notification.service', () => notifications);
const route = vi.hoisted(() => ({
  submitTextModerationOrScan: vi.fn(
    async (): Promise<{ id?: string | null } | null> => ({
      id: 'wf-new',
    })
  ),
}));
vi.mock('~/server/services/text-scan/route', () => route);

dbMock.dbWrite.$executeRaw.mockImplementation(((
  ...a: Parameters<ReturnType<typeof pgliteRaw>['executeRaw']>
) => pgliteRaw(holder.db).executeRaw(...a)) as never);

const { updateServiceOfferingNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { serviceOfferingShowableWhere, shopRatingFilter, serviceOfferingReviewState } = await import(
  '~/server/services/creator-service.service'
);
const { serviceOfferingModerationAdapter, scanServiceOffering } = await import(
  '~/server/services/service-offering-moderation.adapter'
);
const { reconcileAction } = await import('~/server/jobs/service-offering-ingestion-reconcile');

const MIGRATIONS = [
  '20261025120000_creator_services_foundation',
  '20261028150000_creator_service_max_nsfw_level',
  '20261028170000_creator_service_offering_takedown',
  '20270106120000_service_offering_content_scan',
].map((name) =>
  join(process.cwd(), `packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`)
);

const { PG, PG13, R, X } = NsfwLevel;
const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp, "deletedAt" timestamp, muted boolean NOT NULL DEFAULT false);
    CREATE TABLE "Report" (id serial PRIMARY KEY);
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (id serial PRIMARY KEY, ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending',
      "needsReview" text, "nsfwLevel" int NOT NULL DEFAULT 0,
      "tosViolation" boolean NOT NULL DEFAULT false);
    CREATE TABLE "EntityModeration" ("entityType" text NOT NULL, "entityId" int NOT NULL, blocked boolean,
      "triggeredLabels" text[] NOT NULL DEFAULT '{}', result jsonb, "nsfwLevel" int,
      PRIMARY KEY ("entityType", "entityId"));
  `);
  for (const migration of MIGRATIONS) await holder.db.exec(readFileSync(migration, 'utf8'));
});

beforeEach(async () => {
  vi.clearAllMocks();
  await holder.db.exec(`
    TRUNCATE "ServiceOffering", "EntityModeration" RESTART IDENTITY CASCADE;
    DELETE FROM "Image";
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (1);
  `);
});

describe('the offering rating', () => {
  const offering = async (declared: number) => {
    await q(
      `INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "declaredNsfwLevel", "maxNsfwLevel", "updatedAt")
       VALUES (1, 'Portraits', 'desc', 500, 3, $1, $1, now())`,
      [declared]
    );
    return 1;
  };
  const rating = async () =>
    (
      await q<{ maxNsfwLevel: number }>(`SELECT "maxNsfwLevel" FROM "ServiceOffering" WHERE id = 1`)
    )[0].maxNsfwLevel;
  const textVerdict = (level: number) =>
    q(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", result, "nsfwLevel") VALUES ('ServiceOffering', 1, '{"version": 1}', $1)`,
      [level]
    );
  const cover = async (ingestion: string, level: number) => {
    await q(
      `INSERT INTO "Image" (id, ingestion, "nsfwLevel") VALUES (7, $1::"ImageIngestionStatus", $2)`,
      [ingestion, level]
    );
    await q(`UPDATE "ServiceOffering" SET "coverImageId" = 7`);
  };

  it('rates an offering its seller declared PG at the level its text was found to be', async () => {
    const id = await offering(PG);
    await textVerdict(R);
    await updateServiceOfferingNsfwLevels([id]);
    expect(await rating()).toBe(R);
  });

  it('rates an offering R when the fallback check flagged its text, and leaves it when not', async () => {
    const id = await offering(PG13);
    await q(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", blocked, "triggeredLabels") VALUES ('ServiceOffering', 1, false, '{}')`
    );
    await updateServiceOfferingNsfwLevels([id]);
    expect(await rating()).toBe(PG13);
    await q(`UPDATE "EntityModeration" SET "triggeredLabels" = '{nsfw}'`);
    await updateServiceOfferingNsfwLevels([id]);
    expect(await rating()).toBe(R);
  });

  it("lifts the rating to a scanned cover's level, and ignores a cover not scanned yet", async () => {
    const id = await offering(PG13);
    await cover('Pending', X);
    await updateServiceOfferingNsfwLevels([id]);
    expect(await rating()).toBe(PG13);
    await q(`UPDATE "Image" SET ingestion = 'Scanned'`);
    await updateServiceOfferingNsfwLevels([id]);
    expect(await rating()).toBe(X);
  });

  it('lets the seller declare a higher rating than the checks find, never a lower one', async () => {
    const id = await offering(X);
    await textVerdict(R);
    await updateServiceOfferingNsfwLevels([id]);
    expect(await rating()).toBe(X);
    // The seller lowers their pick to PG: the text still holds it at R.
    await q(`UPDATE "ServiceOffering" SET "declaredNsfwLevel" = $1`, [PG]);
    await updateServiceOfferingNsfwLevels([id]);
    expect(await rating()).toBe(R);
  });

  it('takes the stored rating as the pick of a row written before the deploy, and keeps it', async () => {
    // Between the migration and the deploy, the old code wrote the seller's X to maxNsfwLevel only.
    await q(
      `INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "maxNsfwLevel", "updatedAt")
       VALUES (1, 'Portraits', 'desc', 500, 3, $1, now())`,
      [X]
    );
    await textVerdict(PG13);
    await updateServiceOfferingNsfwLevels([1]);
    const [row] = await q<{ maxNsfwLevel: number; declaredNsfwLevel: number }>(
      `SELECT "maxNsfwLevel", "declaredNsfwLevel" FROM "ServiceOffering"`
    );
    expect(row).toEqual({ maxNsfwLevel: X, declaredNsfwLevel: X });
  });

  it('starts an existing offering under review, keeping the rating its seller picked', async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE TABLE "User" (id int PRIMARY KEY, username text);
      CREATE TABLE "Report" (id serial PRIMARY KEY);
      CREATE TABLE "Image" (id int PRIMARY KEY);
      INSERT INTO "User" (id) VALUES (1);
    `);
    for (const migration of MIGRATIONS.slice(0, -1)) await db.exec(readFileSync(migration, 'utf8'));
    await db.exec(`INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "maxNsfwLevel", "coverImageId", "updatedAt")
      VALUES (1, 't', 'd', 500, 3, ${X}, 99, now())`);
    await db.exec(readFileSync(MIGRATIONS[MIGRATIONS.length - 1], 'utf8'));
    const [row] = (
      await db.query<{
        ingestion: string;
        maxNsfwLevel: number;
        declaredNsfwLevel: number | null;
        coverImageId: number | null;
      }>(
        `SELECT ingestion::text, "maxNsfwLevel", "declaredNsfwLevel", "coverImageId" FROM "ServiceOffering"`
      )
    ).rows;
    // The pick stays in maxNsfwLevel until the first recompute; a cover id naming no image is
    // cleared so the key could be added.
    expect(row).toEqual({
      ingestion: 'Pending',
      maxNsfwLevel: X,
      declaredNsfwLevel: null,
      coverImageId: null,
    });
    await db.close();
  });
});

// The subset of Prisma's where semantics the storefront filter uses, evaluated against a row.
type Row = Record<string, unknown>;
const OPERATORS = new Set(['in', 'lte']);
// Prisma operators this evaluator does not implement: a filter using one throws instead of
// silently reading as "no match".
const PRISMA_OPERATORS = new Set([
  'not',
  'notIn',
  'lt',
  'gt',
  'gte',
  'equals',
  'contains',
  'is',
  'isNot',
  'some',
  'none',
  'every',
]);
function matches(row: Row | null, where: Record<string, unknown>): boolean {
  if (!row) return false;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond === null || typeof cond !== 'object') return value === cond;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    const c = cond as Record<string, unknown>;
    const ops = Object.keys(c).filter((k) => OPERATORS.has(k) || PRISMA_OPERATORS.has(k));
    if (!ops.length) return matches(value as Row | null, c);
    if (ops.length !== Object.keys(c).length || ops.some((k) => !OPERATORS.has(k)))
      throw new Error(`unsupported condition on ${key}: ${Object.keys(c).join(', ')}`);
    if ('in' in c) return (c.in as unknown[]).includes(value);
    return (value as number) <= (c.lte as number);
  });
}

describe('which offerings a storefront shows', () => {
  const shown = (row: Row, matureRatings: number[] = []) =>
    matches(row, {
      ...shopRatingFilter(matureRatings),
      ...serviceOfferingShowableWhere(matureRatings),
    });
  const scanned = { maxNsfwLevel: PG13, ingestion: ServiceOfferingIngestionStatus.Scanned };
  const coverRow = (
    ingestion: ImageIngestionStatus,
    nsfwLevel: number,
    needsReview: string | null = null,
    tosViolation = false
  ) => ({
    coverImageId: 7,
    coverImage: { ingestion, nsfwLevel, needsReview, tosViolation },
  });

  it('shows an offering whose cover passed its checks', () => {
    expect(shown({ ...scanned, ...coverRow(ImageIngestionStatus.Scanned, PG) })).toBe(true);
  });

  it('shows a checked offering with no cover', () => {
    expect(shown({ ...scanned, coverImageId: null, coverImage: null })).toBe(true);
  });

  it.each([
    ServiceOfferingIngestionStatus.Pending,
    ServiceOfferingIngestionStatus.Error,
    ServiceOfferingIngestionStatus.Blocked,
  ])('hides an offering whose check is %s', (ingestion) => {
    expect(shown({ ...scanned, ingestion, coverImageId: null, coverImage: null })).toBe(false);
  });

  it.each([
    // Rated PG, so only the check named hides it.
    ['not scanned', coverRow(ImageIngestionStatus.Pending, PG)],
    ['in a rescan', coverRow(ImageIngestionStatus.Rescan, PG)],
    ['blocked', coverRow(ImageIngestionStatus.Blocked, PG)],
    ['held for review', coverRow(ImageIngestionStatus.Scanned, PG, 'poi')],
    ['taken down', coverRow(ImageIngestionStatus.Scanned, PG, null, true)],
  ])('hides an offering whose cover is %s', (_, cover) => {
    expect(shown({ ...scanned, ...cover })).toBe(false);
  });

  it('hides a cover rated above what the viewer may see, even before the rating catches up', () => {
    const row = { ...scanned, ...coverRow(ImageIngestionStatus.Scanned, X) };
    expect(shown(row)).toBe(false);
    expect(shown(row, [X])).toBe(true);
  });
});

describe('what the seller is told', () => {
  const cover = (
    ingestion: ImageIngestionStatus,
    needsReview: string | null = null,
    tosViolation = false
  ) => ({
    ingestion,
    needsReview,
    tosViolation,
  });
  it.each([
    [ServiceOfferingIngestionStatus.Pending, null, 'reviewing'],
    [ServiceOfferingIngestionStatus.Error, null, 'reviewing'],
    [ServiceOfferingIngestionStatus.Blocked, null, 'held'],
    [ServiceOfferingIngestionStatus.Scanned, cover(ImageIngestionStatus.Pending), 'reviewing'],
    [
      ServiceOfferingIngestionStatus.Scanned,
      cover(ImageIngestionStatus.Scanned, 'poi'),
      'reviewing',
    ],
    [ServiceOfferingIngestionStatus.Scanned, cover(ImageIngestionStatus.Blocked), 'held'],
    [ServiceOfferingIngestionStatus.Scanned, cover(ImageIngestionStatus.NotFound), 'held'],
    [
      ServiceOfferingIngestionStatus.Scanned,
      cover(ImageIngestionStatus.Scanned, null, true),
      'held',
    ],
    [ServiceOfferingIngestionStatus.Scanned, cover(ImageIngestionStatus.Scanned), null],
    [ServiceOfferingIngestionStatus.Scanned, null, null],
  ] as const)('%s with cover %o reads %s', (ingestion, coverImage, expected) => {
    expect(serviceOfferingReviewState({ ingestion, coverImage })).toBe(expected);
  });
});

describe('the moderation adapter', () => {
  const OFFERING = 7;
  const SELLER = 42;
  let row: Row;
  // Prisma's `{ not: x }` is outside `matches`; turn it into the set it stands for.
  const inSet = (cond: unknown) =>
    cond && typeof cond === 'object' && 'not' in cond
      ? { in: Object.values(ServiceOfferingIngestionStatus).filter((s) => s !== (cond as Row).not) }
      : cond;
  const where = (w: Row) => ('ingestion' in w ? { ...w, ingestion: inSet(w.ingestion) } : w);
  const storedRating = async () =>
    (
      await q<{ maxNsfwLevel: number }>(
        `SELECT "maxNsfwLevel" FROM "ServiceOffering" WHERE id = $1`,
        [OFFERING]
      )
    )[0].maxNsfwLevel;

  beforeEach(async () => {
    // The rating lives in Postgres (the recompute is real SQL); ingestion in this row.
    await q(`INSERT INTO "User" (id) VALUES ($1)`, [SELLER]);
    await q(
      `INSERT INTO "ServiceOffering" (id, "sellerId", title, description, price, "deliveryDays", "declaredNsfwLevel", "maxNsfwLevel", "updatedAt")
       VALUES ($1, $2, 'Portraits', 'desc', 500, 3, ${PG13}, ${PG13}, now())`,
      [OFFERING, SELLER]
    );
    await q(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", result, "nsfwLevel") VALUES ('ServiceOffering', $1, '{"version": 1}', ${R})`,
      [OFFERING]
    );
    row = {
      id: OFFERING,
      sellerId: SELLER,
      seller: { username: 'badgesmith' },
      ingestion: ServiceOfferingIngestionStatus.Pending,
      scanWorkflowId: 'wf-current',
    };
    dbMock.dbWrite.serviceOffering.updateMany.mockImplementation((async (args: {
      where: Row;
      data: Row;
    }) => {
      const hit = matches(row, where(args.where));
      if (hit) Object.assign(row, args.data);
      return { count: hit ? 1 : 0 };
    }) as never);
    dbMock.dbWrite.serviceOffering.findFirst.mockImplementation((async (args: { where: Row }) =>
      matches(row, where(args.where)) ? row : null) as never);
  });
  const apply = (blocked: boolean, workflowId = 'wf-current') =>
    serviceOfferingModerationAdapter.applyResult!({
      entityId: OFFERING,
      workflowId,
      blocked,
      triggeredLabels: [],
      output: {} as never,
    });

  it('shows an offering whose check passed, at the rating the check found', async () => {
    await apply(false);
    expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Scanned);
    expect(await storedRating()).toBe(R);
  });

  it('holds a blocked offering at its new rating, files a report for moderators and tells the seller once', async () => {
    await apply(true);
    await apply(true);
    expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
    expect(await storedRating()).toBe(R);
    expect(report.createReport).toHaveBeenCalledTimes(1);
    expect(report.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'serviceOffering',
        id: OFFERING,
        reason: 'TOSViolation',
        // A report a moderator already ruled on is not reused, so the queue sees this block.
        foldIntoPendingOnly: true,
      })
    );
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: SELLER,
        details: expect.objectContaining({ url: '/user/badgesmith/shop/manage?tab=services' }),
      })
    );
  });

  it('leaves an offering Pending, with no notice, when its report cannot be filed', async () => {
    report.createReport.mockRejectedValueOnce(new Error('db down'));
    await expect(apply(true)).rejects.toThrow('db down');
    expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Pending);
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });

  it('keeps a blocked offering held when a later check passes', async () => {
    await apply(true);
    await apply(false);
    expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
  });

  it('applies no result from a check for text the seller has since changed', async () => {
    // The seller edited: the text is Pending again and its own check is not recorded yet.
    row.scanWorkflowId = null;
    await apply(false, 'wf-old');
    expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Pending);
    await apply(true, 'wf-old');
    expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Pending);
    expect(report.createReport).not.toHaveBeenCalled();
  });

  it('applies a text-scan verdict only for the current text', async () => {
    const scan = (workflowId: string) =>
      serviceOfferingModerationAdapter.applyTextScan!({
        entityId: OFFERING,
        workflowId,
        outcome: {} as never,
        subject: {} as never,
        textHash: 'h',
      });
    await scan('wf-old');
    expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Pending);
    await scan('wf-current');
    expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Scanned);
  });

  describe('submitting a check', () => {
    // The check id is written by raw SQL, to Postgres; the result is applied to the row above.
    let readAt: Date;
    const storedCheck = async () =>
      (
        await q<{ scanWorkflowId: string | null; updatedAt: Date }>(
          `SELECT "scanWorkflowId", "updatedAt" FROM "ServiceOffering" WHERE id = $1`,
          [OFFERING]
        )
      )[0];
    beforeEach(async () => {
      readAt = (await storedCheck()).updatedAt;
      row.updatedAt = readAt;
      dbMock.dbWrite.serviceOffering.findUnique.mockResolvedValue({
        title: 'Portraits',
        description: 'desc',
        updatedAt: readAt,
      } as never);
      dbMock.dbWrite.entityModeration.findFirst.mockResolvedValue(null as never);
    });

    it('records the check for the text it read, without moving the edit time', async () => {
      await scanServiceOffering(OFFERING);
      expect(await storedCheck()).toEqual({ scanWorkflowId: 'wf-new', updatedAt: readAt });
    });

    it('records nothing when the text changed while the check was submitted', async () => {
      route.submitTextModerationOrScan.mockImplementationOnce(async () => {
        await q(`UPDATE "ServiceOffering" SET "updatedAt" = "updatedAt" + interval '1 second'`);
        return { id: 'wf-stale' };
      });
      await scanServiceOffering(OFFERING);
      expect((await storedCheck()).scanWorkflowId).toBeNull();
    });

    it.each([
      [false, ServiceOfferingIngestionStatus.Scanned],
      [true, ServiceOfferingIngestionStatus.Blocked],
    ])(
      'applies a result (blocked %s) that landed before the check was recorded',
      async (blocked, ingestion) => {
        // The callback came first and matched nothing; the stored row now names this check.
        row.scanWorkflowId = 'wf-new';
        dbMock.dbWrite.entityModeration.findFirst.mockResolvedValueOnce({ blocked } as never);
        await scanServiceOffering(OFFERING);
        expect(dbMock.dbWrite.entityModeration.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ workflowId: 'wf-new', status: 'Succeeded' }),
          })
        );
        expect(row.ingestion).toBe(ingestion);
      }
    );

    it('applies no early result once the text has changed', async () => {
      row.scanWorkflowId = 'wf-new';
      row.updatedAt = new Date(readAt.getTime() + 1000);
      dbMock.dbWrite.entityModeration.findFirst.mockResolvedValueOnce({ blocked: false } as never);
      await scanServiceOffering(OFFERING);
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Pending);
    });
  });

  it('marks a failed check Error only while it is still Pending', async () => {
    const fail = () =>
      serviceOfferingModerationAdapter.applyFailure!({
        entityId: OFFERING,
        workflowId: 'wf-current',
        status: 'failed',
      });
    row.ingestion = ServiceOfferingIngestionStatus.Scanned;
    await fail();
    expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Scanned);
    row.ingestion = ServiceOfferingIngestionStatus.Pending;
    await fail();
    expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Error);
  });
});

describe('the reconcile job', () => {
  const now = new Date('2027-01-06T12:00:00Z');
  const pendingBefore = new Date('2027-01-06T11:30:00Z');
  const edited = new Date('2027-01-06T11:00:00Z');
  const opts = { offeringUpdatedAt: edited, pendingBefore };

  it('submits an offering that was never submitted, which is how existing ones start', () => {
    expect(reconcileAction(null, opts)).toBe('submit');
  });

  it('applies a result that never reached the offering', () => {
    const done = { status: 'Succeeded' as const, updatedAt: now };
    expect(reconcileAction({ ...done, blocked: false }, opts)).toBe('settle');
    expect(reconcileAction({ ...done, blocked: true }, opts)).toBe('block');
  });

  it('resubmits a result older than the last edit instead of applying it', () => {
    const stale = {
      status: 'Succeeded' as const,
      blocked: false,
      updatedAt: new Date('2027-01-06T10:00:00Z'),
    };
    expect(reconcileAction(stale, opts)).toBe('submit');
  });

  it('waits on a recent submit and resubmits a lost one', () => {
    expect(reconcileAction({ status: 'Pending', blocked: null, updatedAt: now }, opts)).toBe(
      'leave'
    );
    expect(
      reconcileAction(
        { status: 'Pending', blocked: null, updatedAt: new Date('2027-01-06T11:00:00Z') },
        opts
      )
    ).toBe('submit');
  });
});
