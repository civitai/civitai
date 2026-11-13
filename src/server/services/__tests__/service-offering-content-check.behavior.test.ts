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

dbMock.dbWrite.$executeRaw.mockImplementation(((
  ...a: Parameters<ReturnType<typeof pgliteRaw>['executeRaw']>
) => pgliteRaw(holder.db).executeRaw(...a)) as never);

const { updateServiceOfferingNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { serviceOfferingShowableWhere, shopRatingFilter, serviceOfferingReviewState } = await import(
  '~/server/services/creator-service.service'
);
const { serviceOfferingModerationAdapter } = await import(
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
      "needsReview" text, "nsfwLevel" int NOT NULL DEFAULT 0);
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

  it('rates an offering R when the fallback check flagged its text', async () => {
    const id = await offering(PG13);
    await q(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", blocked, "triggeredLabels") VALUES ('ServiceOffering', 1, false, '{nsfw}')`
    );
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
      await db.query<{ ingestion: string; declaredNsfwLevel: number; coverImageId: number | null }>(
        `SELECT ingestion::text, "declaredNsfwLevel", "coverImageId" FROM "ServiceOffering"`
      )
    ).rows;
    // A cover id naming no image is cleared so the key could be added.
    expect(row).toEqual({ ingestion: 'Pending', declaredNsfwLevel: X, coverImageId: null });
    await db.close();
  });
});

// The subset of Prisma's where semantics the storefront filter uses, evaluated against a row.
type Row = Record<string, unknown>;
function matches(row: Row | null, where: Record<string, unknown>): boolean {
  if (!row) return false;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond === null || typeof cond !== 'object') return value === cond;
    const c = cond as Record<string, unknown>;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('lte' in c) return (value as number) <= (c.lte as number);
    if (Object.keys(c).some((k) => !['in', 'lte'].includes(k)))
      return matches(value as Row | null, c);
    throw new Error(`unsupported condition on ${key}`);
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
    needsReview: string | null = null
  ) => ({
    coverImageId: 7,
    coverImage: { ingestion, nsfwLevel, needsReview },
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
    ['not scanned', coverRow(ImageIngestionStatus.Pending, 0)],
    ['blocked', coverRow(ImageIngestionStatus.Blocked, NsfwLevel.Blocked)],
    ['held for review', coverRow(ImageIngestionStatus.Scanned, PG, 'poi')],
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
  it.each([
    [ServiceOfferingIngestionStatus.Pending, null, 'reviewing'],
    [ServiceOfferingIngestionStatus.Blocked, null, 'held'],
    [
      ServiceOfferingIngestionStatus.Scanned,
      { ingestion: ImageIngestionStatus.Pending, needsReview: null },
      'reviewing',
    ],
    [
      ServiceOfferingIngestionStatus.Scanned,
      { ingestion: ImageIngestionStatus.Blocked, needsReview: null },
      'held',
    ],
    [ServiceOfferingIngestionStatus.Scanned, null, null],
  ] as const)('%s with cover %o reads %s', (ingestion, coverImage, expected) => {
    expect(serviceOfferingReviewState({ ingestion, coverImage })).toBe(expected);
  });
});

describe('the moderation adapter', () => {
  let row: Row;
  beforeEach(() => {
    row = {
      id: 1,
      sellerId: 1,
      seller: { username: 'badgesmith' },
      ingestion: ServiceOfferingIngestionStatus.Pending,
    };
    dbMock.dbWrite.serviceOffering.updateMany.mockImplementation((async ({
      where,
      data,
    }: {
      where: Row;
      data: Row;
    }) => {
      const hit = matches(
        row,
        'ingestion' in where ? { ...where, ingestion: inSet(where.ingestion) } : where
      );
      if (hit) Object.assign(row, data);
      return { count: hit ? 1 : 0 };
    }) as never);
    dbMock.dbRead.serviceOffering.findUnique.mockImplementation((async () => row) as never);
  });
  // Prisma's `{ not: x }` is outside `matches`; turn it into the set it stands for.
  const inSet = (cond: unknown) =>
    cond && typeof cond === 'object' && 'not' in cond
      ? { in: Object.values(ServiceOfferingIngestionStatus).filter((s) => s !== (cond as Row).not) }
      : cond;
  const apply = (blocked: boolean) =>
    serviceOfferingModerationAdapter.applyResult!({
      entityId: 1,
      workflowId: 'wf',
      blocked,
      triggeredLabels: [],
      output: {} as never,
    });

  it('shows an offering whose check passed', async () => {
    await apply(false);
    expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Scanned);
  });

  it('holds a blocked offering, files one report for moderators and tells the seller once', async () => {
    await apply(true);
    await apply(true);
    expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
    expect(report.createReport).toHaveBeenCalledTimes(1);
    expect(report.createReport).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'serviceOffering', id: 1, reason: 'TOSViolation' })
    );
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        details: expect.objectContaining({ url: '/user/badgesmith/shop/manage?tab=services' }),
      })
    );
  });

  it('keeps a blocked offering held when a later check passes', async () => {
    await apply(true);
    await apply(false);
    expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
  });

  it('marks a failed check Error only while it is still Pending', async () => {
    row.ingestion = ServiceOfferingIngestionStatus.Scanned;
    await serviceOfferingModerationAdapter.applyFailure!({
      entityId: 1,
      workflowId: 'wf',
      status: 'failed',
    });
    expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Scanned);
    row.ingestion = ServiceOfferingIngestionStatus.Pending;
    await serviceOfferingModerationAdapter.applyFailure!({
      entityId: 1,
      workflowId: 'wf',
      status: 'failed',
    });
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
