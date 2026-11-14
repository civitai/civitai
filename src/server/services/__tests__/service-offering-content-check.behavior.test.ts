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
// The label store is not booted here; a csam decision's record of itself is its own test's.
dbMock.dbWrite.$queryRaw.mockImplementation(((
  ...a: Parameters<ReturnType<typeof pgliteRaw>['queryRaw']>
) =>
  Array.isArray(a[0]) && a[0].join('').includes('label_store.record_label')
    ? Promise.resolve([{ record_label: null }])
    : pgliteRaw(holder.db).queryRaw(...a)) as never);

const { updateServiceOfferingNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { serviceOfferingShowableWhere, shopRatingFilter, serviceOfferingReviewState } = await import(
  '~/server/services/creator-service.service'
);
const { serviceOfferingModerationAdapter, scanServiceOffering, requeueBlockedServiceOffering } =
  await import('~/server/services/service-offering-moderation.adapter');
const { reconcileAction, serviceOfferingIngestionReconcile } = await import(
  '~/server/jobs/service-offering-ingestion-reconcile'
);
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');
const { decideCsamHold } = await import('~/server/services/text-scan/csam-hold-decision');

const MIGRATIONS = [
  '20261016150000_text_scan_hold',
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
      status text NOT NULL DEFAULT 'Succeeded', PRIMARY KEY ("entityType", "entityId"));
  `);
  for (const migration of MIGRATIONS) await holder.db.exec(readFileSync(migration, 'utf8'));
});

beforeEach(async () => {
  vi.clearAllMocks();
  await holder.db.exec(`
    TRUNCATE "ServiceOffering", "EntityModeration", "TextScanHold" RESTART IDENTITY CASCADE;
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

  describe('a csam verdict', () => {
    const scan = (detected: boolean) =>
      serviceOfferingModerationAdapter.applyTextScan!({
        entityId: OFFERING,
        workflowId: 'wf-current',
        outcome: {
          csam: { detected, reason: 'r' },
          triggeredLabels: detected ? ['csam'] : [],
          nsfwLevel: null,
        } as never,
        subject: {
          fields: [{ heading: 'Title', text: 'Portraits' }],
          declared: {},
          userId: SELLER,
        },
        textHash: 'h',
      });
    const holds = () =>
      q(`SELECT "entityType", "entityId", label, status::text AS status FROM "TextScanHold"`);
    beforeEach(() => {
      // The hold reads see the rows the hold writes put in Postgres.
      dbMock.dbWrite.textScanHold.findMany.mockImplementation((async () =>
        q(
          `SELECT status::text AS status, "textHash", meta FROM "TextScanHold" WHERE "entityId" = $1`,
          [OFFERING]
        )) as never);
    });

    it('hides the offering', async () => {
      await scan(true);
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
      expect(
        serviceOfferingReviewState({ ingestion: row.ingestion as never, coverImage: null })
      ).toBe('held');
    });

    it('holds it in the csam queue, before hiding it, and files no service report', async () => {
      await scan(true);
      expect(await holds()).toEqual([
        { entityType: 'ServiceOffering', entityId: OFFERING, label: 'csam', status: 'Pending' },
      ]);
      expect(dbMock.dbWrite.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        dbMock.dbWrite.serviceOffering.updateMany.mock.invocationCallOrder[0]
      );
      expect(report.createReport).not.toHaveBeenCalled();
    });

    it('is not released by any later check that passes while its hold is pending', async () => {
      await scan(true);
      // Back to Pending, so only the hold keeps it from settling.
      row.ingestion = ServiceOfferingIngestionStatus.Pending;
      await scan(false);
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
      row.ingestion = ServiceOfferingIngestionStatus.Pending;
      await apply(false);
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
    });

    it('lets a csam verdict on text a moderator dismissed settle', async () => {
      await scan(true);
      await q(`UPDATE "TextScanHold" SET status = 'Dismissed', meta = '{"decision":"dismiss"}'`);
      row.ingestion = ServiceOfferingIngestionStatus.Pending;
      await scan(true);
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Scanned);
    });

    it('holds a csam verdict on text a moderator confirmed, with no service report', async () => {
      await scan(true);
      await q(`UPDATE "TextScanHold" SET status = 'Confirmed', meta = '{"decision":"remove"}'`);
      row.ingestion = ServiceOfferingIngestionStatus.Pending;
      await scan(true);
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
      expect(report.createReport).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['the fallback check', () => apply(true)],
    [
      'a csam verdict',
      () =>
        serviceOfferingModerationAdapter.applyTextScan!({
          entityId: OFFERING,
          workflowId: 'wf-current',
          outcome: { csam: { detected: true, reason: 'r' }, triggeredLabels: ['csam'] } as never,
          subject: { fields: [], declared: {}, userId: SELLER },
          textHash: 'h',
        }),
    ],
  ])('tells the seller only that a moderator is reviewing it, after %s', async (_, block) => {
    await block();
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          message: 'Your service is hidden while a moderator reviews it.',
        }),
      })
    );
  });

  describe('a csam verdict the callback could not apply', () => {
    // The stored rows alone decide it: the verdict row says blocked = false, as every text-scan row does.
    const TEXT = { title: 'Portraits', description: 'desc' };
    const currentHash = textScanTextHash({
      fields: [
        { heading: 'Title', text: TEXT.title },
        { heading: 'Description', text: TEXT.description },
      ],
      declared: {},
    });
    const verdict = (triggeredLabels: string[], textHash: string | null = currentHash) =>
      dbMock.dbWrite.entityModeration.findUnique.mockResolvedValueOnce({
        status: 'Succeeded',
        triggeredLabels,
        result: { version: 1, ...(textHash === null ? {} : { textHash }) },
      } as never);
    const reconcile = async (readAt?: Date) => {
      const old = new Date(Date.now() - 60 * 60_000);
      row.updatedAt = old;
      dbMock.dbRead.serviceOffering.findMany.mockResolvedValueOnce([
        { id: OFFERING, updatedAt: readAt ?? old },
      ] as never);
      dbMock.dbRead.entityModeration.findMany.mockResolvedValueOnce([
        { entityId: OFFERING, status: 'Succeeded', blocked: false, updatedAt: new Date() },
      ] as never);
      return serviceOfferingIngestionReconcile.run({}).result;
    };
    beforeEach(() => {
      dbMock.dbWrite.entityModeration.findUnique.mockReset();
      dbMock.dbWrite.serviceOffering.findUnique.mockResolvedValue({
        ...TEXT,
        updatedAt: new Date(),
      } as never);
      dbMock.dbWrite.serviceOffering.findMany.mockResolvedValue([
        {
          id: OFFERING,
          sellerId: SELLER,
          ...TEXT,
          declaredNsfwLevel: null,
          maxNsfwLevel: PG13,
          status: 'Active',
        },
      ] as never);
    });

    it('stays hidden when its scan matched another check, and the reconcile job holds it', async () => {
      verdict(['csam']);
      await serviceOfferingModerationAdapter.applyTextScan!({
        entityId: OFFERING,
        workflowId: 'wf-other',
        outcome: { csam: { detected: true, reason: 'r' }, triggeredLabels: ['csam'] } as never,
        subject: { fields: [], declared: {}, userId: SELLER },
        textHash: currentHash,
      });
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Pending);
      await reconcile();
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
    });

    it('resubmits, rather than blocks, an offering edited since the reconcile job read it', async () => {
      const old = new Date(Date.now() - 60 * 60_000);
      row.updatedAt = old;
      dbMock.dbRead.serviceOffering.findMany.mockResolvedValueOnce([
        { id: OFFERING, updatedAt: new Date(old.getTime() - 60_000) },
      ] as never);
      dbMock.dbRead.entityModeration.findMany.mockResolvedValueOnce([
        { entityId: OFFERING, status: 'Succeeded', blocked: true, updatedAt: new Date() },
      ] as never);
      await serviceOfferingIngestionReconcile.run({}).result;
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Pending);
      expect(report.createReport).not.toHaveBeenCalled();
      expect(notifications.createNotification).not.toHaveBeenCalled();
      expect(route.submitTextModerationOrScan).toHaveBeenCalledTimes(1);
    });

    it('lets the reconcile job list an offering whose verdict found nothing', async () => {
      verdict([]);
      await reconcile();
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Scanned);
    });

    it('takes up only offerings still unchecked, not removed, and quiet past the grace window', async () => {
      verdict([]);
      const before = Date.now();
      await reconcile();
      const { where } = dbMock.dbRead.serviceOffering.findMany.mock.calls.at(-1)![0] as {
        where: { ingestion: { in: string[] }; status: unknown; updatedAt: { lt: Date } };
      };
      expect(where.ingestion.in.sort()).toEqual(['Error', 'Pending']);
      expect(where.status).toEqual({ not: 'Removed' });
      expect(where.updatedAt.lt.getTime()).toBeLessThanOrEqual(before - 10 * 60_000 + 1000);
    });

    it('leaves an offering edited since the reconcile job read it unshown', async () => {
      verdict([]);
      await reconcile(new Date(Date.now() - 2 * 60 * 60_000));
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Pending);
    });

    it('holds an offering whose verdict landed before its check was recorded', async () => {
      verdict(['csam']);
      row.scanWorkflowId = 'wf-new';
      row.updatedAt = (
        await q<{ updatedAt: Date }>(`SELECT "updatedAt" FROM "ServiceOffering" WHERE id = $1`, [
          OFFERING,
        ])
      )[0].updatedAt;
      dbMock.dbWrite.serviceOffering.findUnique.mockResolvedValue({
        ...TEXT,
        updatedAt: row.updatedAt,
      } as never);
      dbMock.dbWrite.entityModeration.findFirst.mockResolvedValueOnce({ blocked: false } as never);
      await scanServiceOffering(OFFERING);
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
    });

    it('holds an offering with a csam hold still pending, whatever its verdict says', async () => {
      dbMock.dbWrite.textScanHold.findMany.mockResolvedValueOnce([
        { status: 'Pending', textHash: 'other', meta: null },
      ] as never);
      await reconcile();
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
    });

    it('lists an offering once a moderator dismissed the csam hold on its current text', async () => {
      verdict(['csam']);
      dbMock.dbWrite.textScanHold.findMany.mockResolvedValueOnce([
        { status: 'Dismissed', textHash: currentHash, meta: { decision: 'dismiss' } },
      ] as never);
      await reconcile();
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Scanned);
    });

    describe('a scan skipped as already done', () => {
      const skipped = async (reason: 'unchanged' | 'too-short', editedMeanwhile = false) => {
        row.updatedAt = (
          await q<{ updatedAt: Date }>(`SELECT "updatedAt" FROM "ServiceOffering" WHERE id = $1`, [
            OFFERING,
          ])
        )[0].updatedAt;
        dbMock.dbWrite.serviceOffering.findUnique.mockResolvedValue({
          ...TEXT,
          updatedAt: row.updatedAt,
        } as never);
        route.submitTextModerationOrScan.mockImplementationOnce((async (opts: {
          onActiveSkip: (r: string) => Promise<unknown>;
        }) => {
          await opts.onActiveSkip(reason);
          return null;
        }) as never);
        if (editedMeanwhile) row.updatedAt = new Date((row.updatedAt as Date).getTime() + 1000);
        await scanServiceOffering(OFFERING);
      };
      const stored = (triggeredLabels: string[]) =>
        dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
          status: 'Succeeded',
          nsfwLevel: PG13,
          triggeredLabels,
          result: { version: 1, textHash: currentHash },
        } as never);
      const pendingHold = () =>
        dbMock.dbWrite.textScanHold.findMany.mockResolvedValueOnce([
          { status: 'Pending', textHash: currentHash, meta: null },
        ] as never);

      it('holds an offering whose unchanged text still has a csam hold pending', async () => {
        stored([]);
        pendingHold();
        await skipped('unchanged');
        expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
      });

      it('holds an offering whose unchanged text has a stored csam verdict', async () => {
        stored(['csam']);
        await skipped('unchanged');
        expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
      });

      it.each(['unchanged', 'too-short'] as const)(
        'leaves an offering edited while its %s skip settled unshown',
        async (reason) => {
          stored([]);
          await skipped(reason, true);
          expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Pending);
        }
      );

      it('settles an offering whose unchanged text has a clean stored verdict', async () => {
        stored([]);
        await skipped('unchanged');
        expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Scanned);
      });

      it.each([
        [true, ServiceOfferingIngestionStatus.Blocked],
        [false, ServiceOfferingIngestionStatus.Scanned],
      ])(
        'settles text too short to scan unless a hold is pending (%s)',
        async (held, ingestion) => {
          dbMock.dbWrite.textScanHold.findMany.mockResolvedValueOnce(
            (held ? [{ status: 'Pending', textHash: 'h', meta: null }] : []) as never
          );
          await skipped('too-short');
          expect(row.ingestion).toBe(ingestion);
        }
      );
    });

    it('holds an offering the fallback check passed while a csam hold is pending', async () => {
      dbMock.dbWrite.textScanHold.findMany.mockResolvedValueOnce([
        { status: 'Pending', textHash: 'h', meta: null },
      ] as never);
      await apply(false);
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
    });

    it('holds a csam verdict with no text hash to compare', async () => {
      verdict(['csam'], null);
      await reconcile();
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Blocked);
    });

    it.each([
      ['a verdict for text since replaced', () => verdict(['csam'], 'old-hash')],
      ['no verdict at all', () => undefined],
    ])('leaves an offering with %s unshown, and checks it again', async (_, given) => {
      given();
      await reconcile();
      expect(row.ingestion).toBe(ServiceOfferingIngestionStatus.Pending);
      expect(route.submitTextModerationOrScan).toHaveBeenCalledTimes(1);
    });
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
      dbMock.dbWrite.entityModeration.findUnique.mockReset();
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
        // The same row, as the hold check reads it: a fallback-check result.
        dbMock.dbWrite.entityModeration.findUnique.mockResolvedValueOnce({
          status: 'Succeeded',
          triggeredLabels: [],
          result: null,
        } as never);
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
      // A clean verdict: only the edit can keep it from settling.
      dbMock.dbWrite.entityModeration.findUnique.mockResolvedValueOnce({
        status: 'Succeeded',
        triggeredLabels: [],
        result: null,
      } as never);
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

describe('a seller edit to a blocked offering', () => {
  const ID = 9;
  const ingestion = async () =>
    (
      await q<{ ingestion: string }>(
        `SELECT ingestion::text FROM "ServiceOffering" WHERE id = $1`,
        [ID]
      )
    )[0].ingestion;
  const csamHold = (status: string, textHash = 'h', decision = 'remove') =>
    q(
      `INSERT INTO "TextScanHold" ("entityType", "entityId", label, "textHash", text, reason, status, meta, "updatedAt")
       VALUES ('ServiceOffering', $1, 'csam', $2, 't', 'r', $3::"TextScanHoldStatus", $4::jsonb, now())`,
      [ID, textHash, status, JSON.stringify({ decision })]
    );
  const csamVerdict = () =>
    q(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", "triggeredLabels", result, status)
       VALUES ('ServiceOffering', $1, '{csam}', '{"version": 1, "textHash": "h"}', 'Succeeded')`,
      [ID]
    );
  beforeEach(async () => {
    await q(
      `INSERT INTO "ServiceOffering" (id, "sellerId", title, description, price, "deliveryDays", ingestion, "updatedAt")
       VALUES ($1, 1, 'Portraits', 'desc', 500, 3, 'Blocked', now())`,
      [ID]
    );
  });

  it('sends the new text of an offering blocked for another reason back to its check', async () => {
    await requeueBlockedServiceOffering(ID);
    expect(await ingestion()).toBe('Pending');
  });

  it.each([
    ['removed in the csam queue', () => csamHold('Confirmed')],
    ['with a csam hold pending', () => csamHold('Pending', 'h', 'pending')],
    ['with a csam verdict no moderator dismissed', csamVerdict],
  ])('keeps an offering %s blocked and hidden', async (_, given) => {
    await given();
    await requeueBlockedServiceOffering(ID);
    expect(await ingestion()).toBe('Blocked');
  });

  it('requeues an offering whose csam verdict a moderator dismissed for that text', async () => {
    await csamVerdict();
    await csamHold('Dismissed', 'h', 'dismiss');
    await requeueBlockedServiceOffering(ID);
    expect(await ingestion()).toBe('Pending');
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

describe('a moderator dismissing the csam hold on a service offering', () => {
  const ID = 11;
  const TEXT = { title: 'Portraits', description: 'desc' };
  const hashOf = (title: string) =>
    textScanTextHash({
      fields: [
        { heading: 'Title', text: title },
        { heading: 'Description', text: TEXT.description },
      ],
      declared: {},
    });
  const currentHash = hashOf(TEXT.title);
  const offering = async () =>
    (
      await q<Row>(
        `SELECT id, "sellerId", title, description, "declaredNsfwLevel", "maxNsfwLevel",
           status::text AS status, ingestion::text AS ingestion, "updatedAt", "scanWorkflowId"
         FROM "ServiceOffering" WHERE id = $1`,
        [ID]
      )
    )[0];
  const ingestion = async () => (await offering()).ingestion;
  const holdRows = () =>
    q<{ id: number; status: string; textHash: string; meta: Row | null }>(
      `SELECT id, status::text AS status, "textHash", meta FROM "TextScanHold" WHERE "entityId" = $1 ORDER BY id`,
      [ID]
    );
  // The Prisma reads and writes on the offering go to its Postgres row.
  const toSet = (cond: unknown) =>
    cond && typeof cond === 'object' && 'not' in cond
      ? { in: Object.values(ServiceOfferingIngestionStatus).filter((s) => s !== (cond as Row).not) }
      : cond;
  const evaluate = async (w: Row) =>
    matches(await offering(), 'ingestion' in w ? { ...w, ingestion: toSet(w.ingestion) } : w);

  const scan = (textHash: string, workflowId: string) =>
    serviceOfferingModerationAdapter.applyTextScan!({
      entityId: ID,
      workflowId,
      outcome: { csam: { detected: true, reason: 'r' }, triggeredLabels: ['csam'] } as never,
      subject: { fields: [{ heading: 'Title', text: TEXT.title }], declared: {}, userId: 1 },
      textHash,
    });
  const verdictFor = (textHash: string) =>
    q(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", "triggeredLabels", result, status)
       VALUES ('ServiceOffering', $1, '{csam}', $2::jsonb, 'Succeeded')
       ON CONFLICT ("entityType", "entityId") DO UPDATE SET result = EXCLUDED.result`,
      [ID, JSON.stringify({ version: 1, textHash })]
    );
  const decide = async (decision: 'dismiss' | 'remove') => {
    const [hold] = (await holdRows()).filter((h) => h.status === 'Pending');
    return decideCsamHold({
      holdId: hold.id,
      textHash: hold.textHash,
      decision,
      actor: { id: 7 },
      tracker: {} as never,
    });
  };
  const reconcile = () => {
    dbMock.dbRead.serviceOffering.findMany.mockImplementationOnce((async () =>
      q(
        `SELECT id, "updatedAt" FROM "ServiceOffering"
         WHERE ingestion IN ('Pending', 'Error') AND "updatedAt" < now() - interval '10 minutes'`
      )) as never);
    dbMock.dbRead.entityModeration.findMany.mockImplementationOnce((async () =>
      (
        await q<Row>(
          `SELECT "entityId", status, coalesce(blocked, false) AS blocked FROM "EntityModeration"`
        )
      ).map((m) => ({ ...m, updatedAt: new Date() }))) as never);
    return serviceOfferingIngestionReconcile.run({}).result;
  };
  // What the reconcile job's resubmit does: the route answers with a new check id.
  const rescan = () => scanServiceOffering(ID, { forceRescan: true });

  beforeEach(async () => {
    await q(
      `INSERT INTO "ServiceOffering" (id, "sellerId", title, description, price, "deliveryDays", ingestion, "scanWorkflowId", "updatedAt")
       VALUES ($1, 1, $2, $3, 500, 3, 'Pending', 'wf-1', now() - interval '1 hour')`,
      [ID, TEXT.title, TEXT.description]
    );
    dbMock.dbWrite.serviceOffering.findFirst.mockImplementation((async ({
      where,
    }: {
      where: Row;
    }) =>
      (await evaluate(where))
        ? { ...(await offering()), seller: { username: null } }
        : null) as never);
    dbMock.dbWrite.serviceOffering.updateMany.mockImplementation((async ({
      where,
      data,
    }: {
      where: Row;
      data: Row;
    }) => {
      if (!(await evaluate(where))) return { count: 0 };
      await q(
        `UPDATE "ServiceOffering" SET ingestion = $1::"ServiceOfferingIngestionStatus" WHERE id = $2`,
        [data.ingestion, ID]
      );
      return { count: 1 };
    }) as never);
    dbMock.dbWrite.serviceOffering.findMany.mockImplementation((async () => [
      await offering(),
    ]) as never);
    dbMock.dbWrite.serviceOffering.findUnique.mockImplementation((async () => offering()) as never);
    dbMock.dbWrite.entityModeration.findUnique.mockImplementation(
      (async () =>
        (
          await q(
            `SELECT status, "triggeredLabels", result FROM "EntityModeration" WHERE "entityId" = $1`,
            [ID]
          )
        )[0] ?? null) as never
    );
    dbMock.dbWrite.entityModeration.findFirst.mockResolvedValue(null as never);
    dbMock.dbWrite.textScanHold.findMany.mockImplementation((async () => holdRows()) as never);
    dbMock.dbWrite.textScanHold.findFirst.mockImplementation(
      (async ({ where }: { where: { id: number } }) =>
        (
          await q(
            `SELECT id, status::text AS status, "entityType", "entityId", "userId", text, "textHash", meta
           FROM "TextScanHold" WHERE id = $1 AND label = 'csam'`,
            [where.id]
          )
        )[0] ?? null) as never
    );
    dbMock.dbWrite.textScanHold.updateMany.mockImplementation((async ({
      where,
      data,
    }: {
      where: { id: number; textHash: string };
      data: { status: string; decidedAt: Date; decidedById: number; meta: Row };
    }) => ({
      count:
        (
          await holder.db.query(
            `UPDATE "TextScanHold" SET status = $1::"TextScanHoldStatus", "decidedAt" = $2,
               "decidedById" = $3, meta = $4::jsonb
             WHERE id = $5 AND label = 'csam' AND status = 'Pending' AND "textHash" = $6`,
            [
              data.status,
              data.decidedAt,
              data.decidedById,
              JSON.stringify(data.meta),
              where.id,
              where.textHash,
            ]
          )
        ).affectedRows ?? 0,
    })) as never);

    // Held by the csam queue: the check found csam in the current text.
    await verdictFor(currentHash);
    await scan(currentHash, 'wf-1');
    expect(await ingestion()).toBe('Blocked');
    expect((await holdRows()).map((h) => h.status)).toEqual(['Pending']);
  });

  it('sends the offering back to its check, and the reconcile job shows it', async () => {
    await decide('dismiss');
    expect(await ingestion()).toBe('Pending');
    await reconcile();
    expect(await ingestion()).toBe('Scanned');
    expect((await holdRows()).map((h) => h.status)).toEqual(['Dismissed']);
    expect(report.createReport).not.toHaveBeenCalled();
  });

  it('keeps an offering the moderator removed hidden', async () => {
    await decide('remove');
    expect(await ingestion()).toBe('Blocked');
    await reconcile();
    expect(await ingestion()).toBe('Blocked');
  });

  it('keeps it hidden while another hold on it is still pending', async () => {
    await q(
      `INSERT INTO "TextScanHold" ("entityType", "entityId", label, "textHash", text, reason, meta, "updatedAt")
       VALUES ('ServiceOffering', $1, 'csam', 'other', 't', 'r', '{}', now())`,
      [ID]
    );
    const [first] = await holdRows();
    await decideCsamHold({
      holdId: first.id,
      textHash: first.textHash,
      decision: 'dismiss',
      actor: { id: 7 },
      tracker: {} as never,
    });
    expect(await ingestion()).toBe('Blocked');
  });

  it('settles a rescan of the same text that finds csam again, with no new hold', async () => {
    await decide('dismiss');
    await rescan();
    await scan(currentHash, 'wf-new');
    expect(await ingestion()).toBe('Scanned');
    expect(await holdRows()).toHaveLength(1);
    // Nothing brings it back round without a moderator.
    await reconcile();
    expect(await ingestion()).toBe('Scanned');
    expect(await holdRows()).toHaveLength(1);
  });

  it('holds changed text that finds csam after the dismiss in a fresh hold', async () => {
    await decide('dismiss');
    const edited = 'Portraits, revised';
    await q(
      `UPDATE "ServiceOffering" SET title = $1, "updatedAt" = now() - interval '30 minutes' WHERE id = $2`,
      [edited, ID]
    );
    await rescan();
    await verdictFor(hashOf(edited));
    await scan(hashOf(edited), 'wf-new');
    expect(await ingestion()).toBe('Blocked');
    const [dismissed, fresh] = await holdRows();
    expect(dismissed.status).toBe('Dismissed');
    expect(fresh).toMatchObject({ status: 'Pending', textHash: hashOf(edited) });
    expect(fresh.meta).toMatchObject({ kind: 'redetected', priorHoldId: dismissed.id });
    // Only the queue lets it out: neither the job nor a seller edit does.
    await reconcile();
    await requeueBlockedServiceOffering(ID);
    expect(await ingestion()).toBe('Blocked');
    expect(await holdRows()).toHaveLength(2);
    expect(report.createReport).not.toHaveBeenCalled();
  });
});
