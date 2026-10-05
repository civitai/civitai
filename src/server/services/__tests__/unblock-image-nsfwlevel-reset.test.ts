import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

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
//   dbWrite.image.update        report.service.ts:753
const dbWrite = dbMock.dbWrite;
const dbRead = dbMock.dbRead;
const mockFindMany = dbRead.image.findMany;

// The three raw-SQL seams every assertion in this file reads. Declared at module scope because
// they are the file's instrument rather than per-case behaviour; `vi.clearAllMocks()` in the
// beforeEach blocks clears call history without dropping an implementation.
dbWrite.$queryRaw.mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
  capturedQueryRaw.push(Array.isArray(strings) ? strings.join(' ? ') : String(strings));
  return Promise.resolve([]);
});
dbWrite.$executeRawUnsafe.mockImplementation((sql: string) => {
  capturedExecUnsafe.push(String(sql));
  return Promise.resolve(0);
});
dbWrite.$executeRaw.mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
  capturedExecRaw.push(Array.isArray(strings) ? strings.join(' ? ') : String(strings));
  return Promise.resolve(0);
});
// resolveEntityAppeal reads postId+pHash off the appeal image; seed a pHash so the
// approved-path phash unblock (bulkRemoveBlockedImages) has something to remove. Restated
// rather than inherited: the canonical mock has no default for `update`, so it would return
// undefined and the destructure would throw.
dbWrite.image.update.mockResolvedValue({ postId: null, pHash: 999n });
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
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));

const { handleUnblockImages } = await import('../image.service');
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
});

// Second door onto the same bug: a moderator approving an image appeal DIRECTLY via
// report.router `resolveAppeal` (not through handleUnblockImages). resolveEntityAppeal's
// approved branch clears blockedFor/ingestion itself, then calls the SHARED
// resetBlockedNsfwLevel helper (the single source of truth for the level restore) — so a
// rating-locked image is no longer left stuck at Blocked. No recursion (it does not call
// handleUnblockImages).
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
