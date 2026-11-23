import { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

// Regression guard for the "unblock leaves nsfwLevel stuck at Blocked" bug
// (ClickUp 868kfwdzq). Blocking force-sets nsfwLevel=Blocked(32) and leaves the
// rating lock on; the post-unblock recompute (update_nsfw_levels_new) skips
// nsfwLevelLocked rows, so an unblocked image stayed permanently rated Blocked —
// hidden from feeds but publicly reachable by direct id.
//
// The fix lives as SQL inside handleUnblockImages: the unblock UPDATE now resets
// nsfwLevel -> 0 and clears the lock FOR THE Blocked ROWS ONLY, so the following
// updateNsfwLevel() can restore the true (tag-derived) level. The per-row CASE is
// evaluated by Postgres, so the emitted UPDATE is identical regardless of input —
// this asserts the wiring at the dbWrite boundary (the repo's established pattern,
// e.g. update-post-image-hidemeta-bust.test.ts): the reset+unlock is present AND
// the recompute (update_nsfw_levels_new) still fires afterward.
//
// image.service is the graph root; the mock scaffold mirrors the established
// recipe (image-metrics-timeout.test.ts): stub env + infra clients + the
// event-engine-common submodule so importing it boots no real infra. On top of
// that, dbRead/dbWrite are permissive proxies that capture the raw SQL, and the
// few fan-out helpers that actually run are overridden to no-ops.

const capturedQueryRaw: string[] = [];
const capturedExecRaw: string[] = [];
// $queryRaw and $executeRaw together, in call order.
const capturedRawInOrder: string[] = [];
const capturedExecUnsafe: string[] = [];
const capturedClickhouse: string[] = [];

// A permissive proxy is still needed for the clickhouse client, which has no canonical mock.
function makePermissive(overrides: Record<string, unknown> = {}): any {
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return undefined;
      if (prop in overrides) return overrides[prop as string];
      if (!(prop in target)) target[prop as string] = makePermissive();
      return target[prop as string];
    },
    apply() {
      return Promise.resolve([]);
    },
  };
  return new Proxy(function () {}, handler);
}

// dbRead/dbWrite come from the canonical mock (src/__tests__/setup.ts). It vivifies on property
// access exactly like the hand-rolled proxy this replaces, so nothing has to enumerate Prisma's
// surface — but it keeps the two clients DISTINCT, which the local pair also did. Every routing
// claim below is a line in the service, not an inference from the old fixture:
//
//   dbRead.image.findMany       image.service.ts:668   (handleUnblockImages)
//   dbWrite.$queryRaw           image.service.ts:692   (the unblock UPDATE)
//   dbWrite.$executeRaw         image.service.ts:894   (resetBlockedNsfwLevel)
//   dbWrite.$executeRawUnsafe   image.service.ts:878   (updateNsfwLevel, the recompute)
//   dbWrite.appeal.updateManyAndReturn  report.service.ts  (resolveEntityAppeal claims the appeals)
//   dbRead.user.findMany        report.service.ts:743
//   dbWrite.$queryRaw           report.service.ts      (settleResolvedAppeals' image write)
const dbWrite = dbMock.dbWrite;
const dbRead = dbMock.dbRead;
const mockFindMany = dbRead.image.findMany;

// The three raw-SQL seams every assertion in this file reads. Declared at module scope because
// they are the file's instrument rather than per-case behaviour; `vi.clearAllMocks()` in the
// beforeEach blocks clears call history without dropping an implementation.
// The unblock UPDATE's RETURNING: every id it claimed (its `Prisma.join` list) comes back restored.
const unblockedRows = (values: unknown[]) =>
  values.flatMap((v) => {
    const sql = v as { text?: unknown; values?: unknown[] } | null;
    return sql && typeof sql.text === 'string' && sql.values?.length && /^[$\d,\s]*$/.test(sql.text)
      ? sql.values.map((id) => ({ id, keptBlocked: false }))
      : [];
  });

dbWrite.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = Array.isArray(strings) ? strings.join(' ? ') : String(strings);
  capturedQueryRaw.push(sql);
  capturedRawInOrder.push(sql);
  if (/AS "keptBlocked"/.test(sql) && /UPDATE "Image" SET/.test(sql))
    return Promise.resolve(unblockedRows(values));
  // The appeal ruling's image write (`settleResolvedAppeals`) reads postId+pHash back; seed a pHash
  // so the approved-path phash unblock (bulkRemoveBlockedImages) has something to remove.
  if (/RETURNING "postId", "pHash"/.test(sql))
    return Promise.resolve([{ postId: null, pHash: 999n }]);
  return Promise.resolve([]);
});
dbWrite.$executeRawUnsafe.mockImplementation((sql: string) => {
  capturedExecUnsafe.push(String(sql));
  return Promise.resolve(0);
});
dbWrite.$executeRaw.mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
  const sql = Array.isArray(strings) ? strings.join(' ? ') : String(strings);
  capturedExecRaw.push(sql);
  capturedRawInOrder.push(sql);
  return Promise.resolve(0);
});
// Canonical `findUnique` already answers null and `findMany` already answers []; pinned anyway so
// what this file hands the service is readable here rather than in the shared defaults table.
dbRead.image.findUnique.mockResolvedValue(null);
dbRead.user.findMany.mockResolvedValue([]);

// event-engine-common is a git submodule, not checked out by default.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

// Real env validation throws in test; a Proxy hands back safe defaults for whatever
// image.service reads at import time (mirrors image-metrics-timeout.test.ts).
vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: makePermissive({
    // bulkRemoveBlockedImages queries blocked_images via clickhouse.$query — capture it so
    // the appeal-approve phash-unblock wiring is observable.
    $query: (strings: TemplateStringsArray, ..._values: unknown[]) => {
      capturedClickhouse.push(Array.isArray(strings) ? strings.join(' ? ') : String(strings));
      return Promise.resolve([]);
    },
    insert: async () => undefined,
  }),
}));

// redis/sysRedis are deeply path-accessed at module load and used by the caches the fan-out
// touches (thumbnailCache.refresh). The canonical mock (src/__tests__/setup.ts) vivifies to any
// depth the same way the local proxies did, and additionally supplies the REAL REDIS_*_KEYS
// tables — the local ones answered every lookup with the same placeholder. Nothing here asserts
// a key.

// Fan-out helpers that actually execute in the reduced unblock path (postId/pHash null,
// no appeal, no moderatorId) — overridden to no-ops so only the SQL wiring is exercised.
vi.mock('~/server/services/image-review.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getImagTagsForReviewByImageIds: vi.fn(async () => []),
  deleteImagTagsForReviewByImageIds: vi.fn(),
}));
vi.mock('~/server/services/tagsOnImageNew.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  upsertTagsOnImageNew: vi.fn(),
}));
vi.mock('~/server/services/nsfwLevels.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queueComicsForPanelImages: vi.fn(),
  queueComicsForPanelImage: vi.fn(),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createNotification: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refundMultiAccountTransaction: vi.fn(async () => ({})),
  refundTransaction: vi.fn(async () => ({})),
}));
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));

vi.mock('~/server/services/image-models-reindex.service', () => ({
  queueDocumentsForImageMinorChanges: vi.fn(async () => undefined),
  queueArticlesAndComicsForImages: vi.fn(async () => undefined),
  queueDocumentsForBlockedImages: vi.fn(async () => undefined),
}));

const { handleUnblockImages, handleBlockImages, rescanUnratedImages } = await import(
  '../image.service'
);
const { unblockAccountDeletionImages } = await import('../account-deletion-images');
const { imagesMetricsSearchIndex } = await import('~/server/search-index');
const { queueDocumentsForImageMinorChanges, queueDocumentsForBlockedImages } = await import(
  '~/server/services/image-models-reindex.service'
);
const { resolveEntityAppeal } = await import('../report.service');
const { createNotification } = await import('../notification.service');
const { refundMultiAccountTransaction } = await import('../buzz.service');
const { logToAxiom } = await import('~/server/logging/client');
const { isSafeToRetry } = await import('@civitai/buzz');

const BLOCKED = 32;
// Prisma string enums (member === value); literals avoid a vitest/tsserver alias artifact.
const ENTITY_IMAGE = 'Image';
const APPEAL_APPROVED = 'Approved';

type AppealRow = {
  id: number;
  entityId: number;
  entityType: string;
  userId: number;
  status: string;
  buzzTransactionId: string | null;
  createdAt: Date;
};
type AppealWhere = {
  id?: { in: number[] };
  entityId?: { in: number[] };
  entityType?: string;
  status?: string;
};
const matchesAppeal = (row: AppealRow, where: AppealWhere) =>
  (!where.id || where.id.in.includes(row.id)) &&
  (!where.entityId || where.entityId.in.includes(row.entityId)) &&
  (!where.entityType || row.entityType === where.entityType) &&
  (!where.status || row.status === where.status);

// The Appeal table as rows behind both read-then-update (findMany + updateMany) and the claiming
// update, so a revert to read-then-update is measured against the same data.
function useAppealTable(rows: AppealRow[]) {
  dbRead.appeal.findMany.mockImplementation(async ({ where }: { where: AppealWhere }) =>
    rows.filter((row) => matchesAppeal(row, where)).map((row) => ({ ...row }))
  );
  const update = ({ where, data }: { where: AppealWhere; data: Partial<AppealRow> }) => {
    const hit = rows.filter((row) => matchesAppeal(row, where));
    for (const row of hit) Object.assign(row, data);
    return hit.map((row) => ({ ...row }));
  };
  dbWrite.appeal.updateMany.mockImplementation(async (args: Parameters<typeof update>[0]) => ({
    count: update(args).length,
  }));
  dbWrite.appeal.updateManyAndReturn.mockImplementation(
    async (args: Parameters<typeof update>[0]) => update(args)
  );
}

describe('handleUnblockImages — nsfwLevel reset+unlock on unblock (ClickUp 868kfwdzq)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedQueryRaw.length = 0;
    capturedExecUnsafe.length = 0;
    // A rating-locked image stuck at Blocked (KoNo/mod-rated then TOS'd) being unblocked.
    mockFindMany.mockResolvedValue([
      {
        id: 128489949,
        userId: 1,
        pHash: null,
        postId: null,
        nsfwLevel: BLOCKED,
        blockedFor: 'Moderated',
        needsReview: null,
      },
    ]);
  });

  it('resets nsfwLevel and clears the lock for Blocked rows, then recomputes', async () => {
    await handleUnblockImages({
      ids: [128489949],
      moderatorId: undefined,
      removeMinorFlag: false,
    } as any);

    const resetSql = capturedExecRaw.join('\n');

    // Blocked rows are reset to Unrated (0) and unlocked (scoped by the WHERE to
    // nsfwLevel = Blocked only), so the recompute below isn't a no-op.
    expect(resetSql).toContain('"nsfwLevel" = 0');
    expect(resetSql).toContain('"nsfwLevelLocked" = FALSE');
    expect(resetSql).toContain('AND "nsfwLevel" =');

    // The reset/unlock must be followed by the recompute — otherwise the row would
    // sit at Unrated instead of its true level.
    expect(capturedExecUnsafe.some((sql) => sql.includes('update_nsfw_levels_new'))).toBe(true);
  });

  // An accept out of the minor queue rewrites "minor", which no trigger watches.
  it('queues the models and articles of the unblocked images', async () => {
    await handleUnblockImages({ ids: [128489949], moderatorId: undefined } as any);
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({ minorImageIds: [128489949] });
  });

  it("checks for an earlier review before writing this unblock's own review row", async () => {
    capturedRawInOrder.length = 0;
    await handleUnblockImages({ ids: [128489949], moderatorId: 9, removeMinorFlag: false } as any);

    const rescan = capturedRawInOrder.findIndex((sql) => sql.includes('FROM "ModActivity" m'));
    const ownReview = capturedRawInOrder.findIndex((sql) =>
      sql.includes('INSERT INTO "ModActivity"')
    );
    expect(rescan).toBeGreaterThanOrEqual(0);
    expect(ownReview).toBeGreaterThan(rescan);
  });
});

describe('handleBlockImages and the search documents showing the images', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([
      {
        id: 128489949,
        userId: 1,
        pHash: null,
        postId: null,
        nsfwLevel: 1,
        blockedFor: null,
        needsReview: null,
      },
    ]);
  });

  // No trigger watches a block: the models, bounties and other documents showing the image are
  // queued here, whatever its minor flag.
  it('queues every document showing the blocked images', async () => {
    await handleBlockImages({ ids: [128489949], moderatorId: 9 } as any);
    expect(queueDocumentsForBlockedImages).toHaveBeenCalledTimes(1);
    expect(queueDocumentsForBlockedImages).toHaveBeenCalledWith([128489949]);
  });
});

describe('handleUnblockImages and a CSAM block', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([
      {
        id: 1,
        userId: 1,
        pHash: null,
        postId: null,
        nsfwLevel: 32,
        blockedFor: 'CSAM',
        needsReview: null,
      },
      {
        id: 2,
        userId: 1,
        pHash: null,
        postId: null,
        nsfwLevel: 32,
        blockedFor: 'moderated',
        needsReview: null,
      },
    ] as never);
  });

  it('leaves the CSAM-blocked image alone and unblocks the other', async () => {
    const result = await handleUnblockImages({ ids: [1, 2], moderatorId: undefined } as any);

    const unblock = dbWrite.$queryRaw.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join('?').includes('AS "keptBlocked"')
    );
    // The ids the UPDATE claimed, then the per-row CSAM re-check it carries.
    const bound = unblock.map(([strings, ...values]) =>
      // (the last value is RETURNING's kept-blocked status)
      Prisma.sql(strings as never, ...(values as never[])).values.slice(-3, -1)
    );
    expect(bound).toEqual([[2, 'CSAM']]);
    expect(result.restored.map((image) => image.id)).toEqual([2]);
  });

  it('leaves alone an image the replica still shows unblocked but the primary has CSAM-blocked', async () => {
    const passthrough = dbWrite.$queryRaw.getMockImplementation()!;
    dbWrite.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) =>
      (strings as unknown as string[]).join('?').includes('SELECT id FROM "Image"')
        ? Promise.resolve([{ id: 2 }])
        : passthrough(strings, ...values)) as never);
    try {
      const result = await handleUnblockImages({ ids: [1, 2], moderatorId: undefined } as any);

      expect(result).toEqual({ restored: [], kept: [] });
      const drops = dbWrite.$executeRaw.mock.calls.filter(([strings]) =>
        (strings as TemplateStringsArray)
          .join('?')
          .includes('DELETE FROM "ImageDeferredBlockEffect"')
      );
      expect(drops).toEqual([]);
    } finally {
      dbWrite.$queryRaw.mockImplementation(passthrough as never);
    }
  });
});

// Second door onto the same bug: a moderator approving an image appeal DIRECTLY via
// report.router `resolveAppeal` (not through handleUnblockImages). resolveEntityAppeal's
// approved branch clears blockedFor/ingestion itself, then calls the SHARED
// resetBlockedNsfwLevel helper (the single source of truth for the level restore) — so a
// rating-locked image is no longer left stuck at Blocked. No recursion (it does not call
// handleUnblockImages).
describe('handleUnblockImages and a block that put its effects off', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedExecRaw.length = 0;
    mockFindMany.mockResolvedValue([
      {
        id: 128489949,
        userId: 1,
        pHash: null,
        postId: null,
        nsfwLevel: 32,
        blockedFor: 'moderated',
        needsReview: 'csam',
      },
    ] as never);
  });

  it('drops them unfired', async () => {
    await handleUnblockImages({ ids: [128489949], moderatorId: undefined } as any);

    const drops = dbWrite.$executeRaw.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join('?').includes('DELETE FROM "ImageDeferredBlockEffect"')
    );
    expect(drops.map((d) => d.slice(1))).toEqual([[[128489949]]]);
  });
});

describe('resolveEntityAppeal — reset+unlock on appeal approval (ClickUp 868kfwdzq, 2nd door)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedQueryRaw.length = 0;
    capturedExecRaw.length = 0;
    capturedExecUnsafe.length = 0;
    capturedClickhouse.length = 0;
    useAppealTable([
      {
        id: 555,
        entityId: 128489949,
        entityType: ENTITY_IMAGE,
        userId: 1,
        status: 'Pending',
        buzzTransactionId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
  });

  it('calls the shared reset+unlock helper on approval, then recomputes', async () => {
    await resolveEntityAppeal({
      ids: [128489949],
      entityType: ENTITY_IMAGE,
      status: APPEAL_APPROVED,
      userId: 2023372,
    } as any);

    const resetSql = capturedExecRaw.join('\n');

    expect(resetSql).toContain('"nsfwLevel" = 0');
    expect(resetSql).toContain('"nsfwLevelLocked" = FALSE');
    expect(resetSql).toContain('AND "nsfwLevel" =');
    expect(capturedExecUnsafe.some((sql) => sql.includes('update_nsfw_levels_new'))).toBe(true);
  });

  it('clears the appeal review on the approved image, which a scan would keep', async () => {
    const pg = new PGlite();
    await pg.exec(`CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Rescan', 'Error', 'Blocked');
      CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp);
      CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, "postId" int, "pHash" bigint,
      "nsfwLevel" int NOT NULL, "needsReview" text, "blockedFor" text, metadata jsonb,
      ingestion "ImageIngestionStatus");
      INSERT INTO "User" VALUES (1, NULL);
      INSERT INTO "Image" VALUES (128489949, 1, NULL, 999, 32, 'appeal', 'moderated', '{}'::jsonb, 'Blocked');`);
    const raw = pgliteRaw(pg);
    const capture = dbWrite.$queryRaw.getMockImplementation();
    dbWrite.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) =>
      /RETURNING "postId", "pHash"/.test(strings.join(''))
        ? raw.queryRaw(strings, ...values)
        : capture!(strings, ...values)) as never);

    try {
      await resolveEntityAppeal({
        ids: [128489949],
        entityType: ENTITY_IMAGE,
        status: APPEAL_APPROVED,
        userId: 2023372,
      } as any);
      const { rows } = await pg.query<{ needsReview: string | null; ingestion: string }>(
        `SELECT "needsReview", ingestion FROM "Image"`
      );
      // Control: the approval's write landed, so the review below is its doing.
      expect(rows[0].ingestion).toBe('Scanned');
      expect(rows[0].needsReview).toBeNull();
    } finally {
      if (capture) dbWrite.$queryRaw.mockImplementation(capture);
      await pg.close();
    }
  });

  it('removes the approved image pHash from the blocked-hash set', async () => {
    await resolveEntityAppeal({
      ids: [128489949],
      entityType: ENTITY_IMAGE,
      status: APPEAL_APPROVED,
      userId: 2023372,
    } as any);

    // bulkRemoveBlockedImages only reaches its clickhouse query when it's handed a non-empty
    // hash list — so a blocked_images query proves the pHash was wired through on approval.
    expect(capturedClickhouse.some((sql) => sql.includes('blocked_images'))).toBe(true);
  });

  it('does NOT touch the blocked-hash set when the appeal is denied', async () => {
    await resolveEntityAppeal({
      ids: [128489949],
      entityType: ENTITY_IMAGE,
      status: 'Rejected',
      userId: 2023372,
    } as any);

    expect(capturedClickhouse.some((sql) => sql.includes('blocked_images'))).toBe(false);
  });

  // An image can be appealed again after a re-block, and a reopened appeal keeps its row. The
  // notification service reuses the row for a repeated key, so a per-entity key would show the
  // second decision as the first one.
  it('keys the resolution notification by appeal, not only by image', async () => {
    await resolveEntityAppeal({
      ids: [128489949],
      entityType: ENTITY_IMAGE,
      status: 'Rejected',
      userId: 2023372,
    } as any);

    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        key: `entity-appeal-resolved:Image:128489949:555:${Date.parse('2026-01-01T00:00:00Z')}`,
        category: 'Moderation',
      })
    );
  });

  // With several appeals per image, only the pending one may be closed, refunded and notified.
  it('resolves only the pending appeal when the image also has an earlier, decided one', async () => {
    const rows = [
      {
        id: 554,
        entityId: 128489949,
        entityType: ENTITY_IMAGE,
        userId: 1,
        status: 'Approved',
        buzzTransactionId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 555,
        entityId: 128489949,
        entityType: ENTITY_IMAGE,
        userId: 1,
        status: 'Pending',
        buzzTransactionId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    useAppealTable(rows);

    await resolveEntityAppeal({
      ids: [128489949],
      entityType: ENTITY_IMAGE,
      status: 'Rejected',
      userId: 2023372,
    } as any);

    expect(rows.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 554, status: 'Approved' },
      { id: 555, status: 'Rejected' },
    ]);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  // Two moderators (or a double submit) resolving one appeal both used to read it Pending, and
  // each refunded it. Only the resolution whose update closes the row may refund.
  it('refunds the fee once when two resolutions of one appeal race', async () => {
    useAppealTable([
      {
        id: 555,
        entityId: 128489949,
        entityType: ENTITY_IMAGE,
        userId: 1,
        status: 'Pending',
        buzzTransactionId: 'appeal-1-1790000000000-abcd1234',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const resolve = () =>
      resolveEntityAppeal({
        ids: [128489949],
        entityType: ENTITY_IMAGE,
        status: APPEAL_APPROVED,
        userId: 2023372,
      } as any);

    await Promise.all([resolve(), resolve()]);

    expect(refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  // Decision, not an accident: a timed-out refund may still have landed, so retrying it can pay
  // the fee back twice. Do not restore a blanket retry around this call.
  it('retries an appeal refund only when the request never reached Buzz', async () => {
    useAppealTable([
      {
        id: 555,
        entityId: 128489949,
        entityType: ENTITY_IMAGE,
        userId: 1,
        status: 'Pending',
        buzzTransactionId: 'appeal-1-1790000000000-abcd1234',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    await resolveEntityAppeal({
      ids: [128489949],
      entityType: ENTITY_IMAGE,
      status: APPEAL_APPROVED,
      userId: 2023372,
    } as any);

    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: 'appeal-1-1790000000000-abcd1234' }),
      { shouldRetry: isSafeToRetry }
    );
  });

  it('does not resend an appeal refund that timed out', async () => {
    useAppealTable([
      {
        id: 555,
        entityId: 128489949,
        entityType: ENTITY_IMAGE,
        userId: 1,
        status: 'Pending',
        buzzTransactionId: 'appeal-1-1790000000000-abcd1234',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    vi.mocked(refundMultiAccountTransaction).mockRejectedValueOnce(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    );

    await resolveEntityAppeal({
      ids: [128489949],
      entityType: ENTITY_IMAGE,
      status: APPEAL_APPROVED,
      userId: 2023372,
    } as any);

    expect(refundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'resolve-entity-appeal',
        appealId: 555,
        buzzTransactionId: 'appeal-1-1790000000000-abcd1234',
      })
    );
  });
});

// PERMIT site of the minor content rule: a moderator's plain Accept in the minor review queue
// clears the minor flag on mature images and keeps it on safe ones. It is not a gate that hides,
// so it stays off the shared rule; swapping the rule in here keeps mature images flagged.
describe('handleUnblockImages — minor queue Accept truth table', () => {
  it('clears the minor flag on mature images and keeps it on safe ones', async () => {
    const pg = new PGlite();
    await pg.exec(`CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Rescan', 'Error', 'Blocked');
      CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp);
      CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, "nsfwLevel" int NOT NULL,
      minor boolean NOT NULL, "needsReview" text, "blockedFor" text, metadata jsonb,
      "scannedAt" timestamp, ingestion "ImageIngestionStatus", "scanJobs" jsonb);
      CREATE TABLE "TagsOnImageDetails" ("imageId" int, disabled boolean);
      CREATE TABLE "ModActivity" ("entityType" text, "entityId" int, activity text);`);
    const levels: [number, boolean][] = [
      [0, true],
      [1, true],
      [2, true],
      [4, false],
      [8, false],
      [16, false],
    ];
    for (const [i, [nsfwLevel]] of levels.entries())
      await pg.query(
        `INSERT INTO "Image" VALUES ($1, NULL, $2, true, 'minor', NULL, '{}'::jsonb, NULL, 'Pending')`,
        [i + 1, nsfwLevel]
      );
    const raw = pgliteRaw(pg);
    const capture = dbWrite.$queryRaw.getMockImplementation();
    dbWrite.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.join('').includes('UPDATE "Image"')
        ? raw.queryRaw(strings, ...values)
        : Promise.resolve([])) as never);
    mockFindMany.mockResolvedValue(
      levels.map(([nsfwLevel], i) => ({
        id: i + 1,
        userId: 1,
        pHash: null,
        postId: null,
        nsfwLevel,
        blockedFor: null,
        needsReview: 'minor',
      })) as never
    );

    try {
      await handleUnblockImages({
        ids: levels.map((_, i) => i + 1),
        moderatorId: undefined,
        removeMinorFlag: false,
      } as any);
      const { rows } = await pg.query<{ nsfwLevel: number; minor: boolean; needsReview: string }>(
        `SELECT "nsfwLevel", minor, "needsReview" FROM "Image" ORDER BY id`
      );
      expect(rows.map((row) => [row.nsfwLevel, row.minor])).toEqual(levels);
      // A moderator's decision clears the review a scan could only add to.
      expect(rows.map((row) => row.needsReview)).toEqual(levels.map(() => null));
    } finally {
      if (capture) dbWrite.$queryRaw.mockImplementation(capture);
      await pg.close();
    }
  });
});

// Policy: LIFT_WHILE_OWNER_DELETED in @civitai/shared/account-deletion-grace: a deleted owner's image is never served.
describe('handleUnblockImages while the owner is deleted', () => {
  it('keeps the image Blocked, recorded as Scanned for an account restore; another owner is restored', async () => {
    const pg = new PGlite();
    await pg.exec(`CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Rescan', 'Error', 'Blocked');
      CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp, "bannedAt" timestamp);
      CREATE TYPE "EntityType" AS ENUM ('Image');
      CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
      CREATE TABLE "Appeal" ("entityType" "EntityType", "entityId" int, status "AppealStatus");
      CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, "postId" int, "nsfwLevel" int NOT NULL,
      minor boolean NOT NULL DEFAULT false, "needsReview" text, "blockedFor" text, metadata jsonb,
      "scannedAt" timestamp, ingestion "ImageIngestionStatus", "scanJobs" jsonb);
      CREATE TABLE "TagsOnImageDetails" ("imageId" int, disabled boolean);
      CREATE TABLE "ModActivity" ("userId" int, "entityType" text, "entityId" int, activity text);
      CREATE DOMAIN "JobQueueType" AS text;
      CREATE TABLE "JobQueue" ("entityId" int, "entityType" "EntityType", type "JobQueueType",
        "createdAt" timestamp(3) NOT NULL DEFAULT now(), PRIMARY KEY ("entityType", "entityId", type));
      INSERT INTO "JobQueue" VALUES (1, 'Image', 'BlockedImageDelete', '2026-01-01');
      INSERT INTO "User" VALUES (1, now()), (2, NULL);
      INSERT INTO "Image" (id, "userId", "nsfwLevel", "blockedFor", metadata, ingestion) VALUES
        (1, 1, 4, 'moderated', '{"ruleId": 3, "keep": 1}', 'Blocked'),
        (2, 2, 32, 'moderated', '{"ruleId": 3, "keep": 1}', 'Blocked');`);
    const raw = pgliteRaw(pg);
    const capture = dbWrite.$queryRaw.getMockImplementation();
    const captureExec = dbWrite.$executeRaw.getMockImplementation();
    dbWrite.$executeRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) =>
      /INSERT INTO "(ModActivity|JobQueue)"/.test(strings.join(''))
        ? raw.executeRaw(strings, ...values)
        : Promise.resolve(0)) as never);
    vi.mocked(imagesMetricsSearchIndex.queueUpdate).mockClear();
    dbWrite.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) =>
      /AS "keptBlocked"|RETURNING "Image".id/.test(strings.join(''))
        ? raw.queryRaw(strings, ...values)
        : Promise.resolve([])) as never);
    mockFindMany.mockResolvedValue(
      [1, 2].map((id) => ({
        id,
        userId: id,
        pHash: null,
        postId: null,
        nsfwLevel: 32,
        blockedFor: 'moderated',
        needsReview: null,
      })) as never
    );

    try {
      const result = await handleUnblockImages({ ids: [1, 2], moderatorId: 9 } as any);
      expect({
        restored: result.restored.map((x) => x.id),
        kept: result.kept.map((x) => x.id),
      }).toEqual({ restored: [2], kept: [1] });
      const { rows } = await pg.query<{
        id: number;
        ingestion: string;
        blockedFor: string | null;
        metadata: unknown;
      }>(
        `SELECT id, ingestion::text AS ingestion, "blockedFor", metadata FROM "Image" ORDER BY id`
      );
      expect(rows).toEqual([
        {
          id: 1,
          ingestion: 'Blocked',
          blockedFor: 'moderated',
          metadata: {
            keep: 1,
            accountDeletionPriorIngestion: 'Scanned',
            accountDeletionPriorBlockedFor: null,
            accountDeletionPriorNeedsReview: null,
          },
        },
        { id: 2, ingestion: 'Scanned', blockedFor: null, metadata: { keep: 1 } },
      ]);
      const level = await pg.query(`SELECT "nsfwLevel" FROM "Image" WHERE id = 1`);
      expect(level.rows).toEqual([{ nsfwLevel: 32 }]);
      // Not a takedown activity for the kept row; 'review' only for the restored one.
      const acts = await pg.query(`SELECT "entityId", activity FROM "ModActivity" ORDER BY 1`);
      expect(acts.rows).toEqual([
        { entityId: 1, activity: 'reviewOwnerDeleted' },
        { entityId: 2, activity: 'review' },
      ]);
      // The kept row's purge clock starts again.
      const clock = await pg.query(
        `SELECT "createdAt" > now() - interval '1 hour' AS fresh FROM "JobQueue" WHERE "entityId" = 1`
      );
      expect(clock.rows).toEqual([{ fresh: true }]);
      // Out of search for the kept row, updated for the restored one.
      expect(
        vi.mocked(imagesMetricsSearchIndex.queueUpdate).mock.calls.flatMap(([items]) => items)
      ).toEqual(
        expect.arrayContaining([
          { id: 1, action: SearchIndexUpdateQueueAction.Delete },
          { id: 2, action: SearchIndexUpdateQueueAction.Update },
        ])
      );

      // The owner comes back: the account restore brings the kept image back Scanned.
      await pg.query(`UPDATE "User" SET "deletedAt" = NULL WHERE id = 1`);
      await unblockAccountDeletionImages(1);
      const back = await pg.query(
        `SELECT ingestion::text AS ingestion, "blockedFor", metadata FROM "Image" WHERE id = 1`
      );
      expect(back.rows).toEqual([
        { ingestion: 'Scanned', blockedFor: null, metadata: { keep: 1 } },
      ]);
    } finally {
      if (capture) dbWrite.$queryRaw.mockImplementation(capture);
      if (captureExec) dbWrite.$executeRaw.mockImplementation(captureExec);
      await pg.close();
    }
  });
});

// Policy: LIFT_WHILE_OWNER_DELETED in @civitai/shared/account-deletion-grace: a deleted owner's image is never served.
describe('rescanUnratedImages after a lift kept blocked for a deleted owner', () => {
  it('counts the kept lift as a moderator review and does not send the image back to the scanner', async () => {
    const pg = new PGlite();
    await pg.exec(`CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Rescan', 'Error', 'Blocked');
      CREATE TABLE "Image" (id int PRIMARY KEY, "nsfwLevel" int NOT NULL, "blockedFor" text,
        ingestion "ImageIngestionStatus", "scanJobs" jsonb);
      CREATE TABLE "TagsOnImageDetails" ("imageId" int, disabled boolean);
      CREATE TABLE "ModActivity" ("entityType" text, "entityId" int, activity text);
      INSERT INTO "Image" VALUES (1, 0, NULL, 'Scanned', NULL), (2, 0, NULL, 'Scanned', NULL);
      INSERT INTO "ModActivity" VALUES ('image', 1, 'reviewOwnerDeleted');`);
    const raw = pgliteRaw(pg);
    const capture = dbWrite.$queryRaw.getMockImplementation();
    dbWrite.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.join('').includes('RETURNING i.id, i.ingestion')
        ? raw.queryRaw(strings, ...values)
        : Promise.resolve([])) as never);
    try {
      await rescanUnratedImages([1, 2]);
      const { rows } = await pg.query<{ id: number; ingestion: string }>(
        `SELECT id, ingestion::text AS ingestion FROM "Image" ORDER BY id`
      );
      expect(rows).toEqual([
        { id: 1, ingestion: 'Scanned' },
        { id: 2, ingestion: 'Rescan' },
      ]);
    } finally {
      if (capture) dbWrite.$queryRaw.mockImplementation(capture);
      await pg.close();
    }
  });
});
