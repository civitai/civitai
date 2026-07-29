import { describe, it, expect, vi, beforeEach } from 'vitest';

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
// recipe (image-metrics-timeout.test.ts): stub env + infra clients + the private
// event-engine-common submodule so importing it boots no real infra. On top of
// that, dbRead/dbWrite are permissive proxies that capture the raw SQL, and the
// few fan-out helpers that actually run are overridden to no-ops.

const { mockFindMany, mockAppealFindMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockAppealFindMany: vi.fn(),
}));

// --- permissive DB proxy: any method resolves empty; specific seams captured ----------
const capturedQueryRaw: string[] = [];
const capturedExecRaw: string[] = [];
const capturedExecUnsafe: string[] = [];
const capturedClickhouse: string[] = [];

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

const dbWrite = makePermissive({
  // handleUnblockImages emits the unblock UPDATE via a $queryRaw tagged template.
  $queryRaw: (strings: TemplateStringsArray, ..._values: unknown[]) => {
    capturedQueryRaw.push(Array.isArray(strings) ? strings.join(' ? ') : String(strings));
    return Promise.resolve([]);
  },
  // updateNsfwLevel() runs the recompute via $executeRawUnsafe.
  $executeRawUnsafe: (sql: string) => {
    capturedExecUnsafe.push(String(sql));
    return Promise.resolve(0);
  },
  // resetBlockedNsfwLevel() emits its reset+unlock UPDATE via a $executeRaw tagged template.
  $executeRaw: (strings: TemplateStringsArray, ..._values: unknown[]) => {
    capturedExecRaw.push(Array.isArray(strings) ? strings.join(' ? ') : String(strings));
    return Promise.resolve(0);
  },
  // resolveEntityAppeal reads postId+pHash off the appeal image; seed a pHash so the
  // approved-path phash unblock (bulkRemoveBlockedImages) has something to remove.
  image: makePermissive({ update: async () => ({ postId: null, pHash: 999n }) }),
});

const dbRead = makePermissive({
  image: makePermissive({ findMany: mockFindMany, findUnique: async () => null }),
  appeal: makePermissive({ findMany: mockAppealFindMany }),
  user: makePermissive({ findMany: async () => [] }),
});

vi.mock('~/server/db/client', () => ({ dbRead, dbWrite }));

// event-engine-common is a private git submodule not checked out in this worktree.
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

// redis/sysRedis are deeply path-accessed at module load and used by the caches the
// fan-out touches (thumbnailCache.refresh). Permissive proxies keep every access safe.
vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: makePermissive({ packed: makePermissive() }),
    sysRedis: makePermissive(),
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
  };
});

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
vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));

const { handleUnblockImages } = await import('../image.service');
const { resolveEntityAppeal } = await import('../report.service');

const BLOCKED = 32;
// Prisma string enums (member === value); literals avoid a vitest/tsserver alias artifact.
const ENTITY_IMAGE = 'Image';
const APPEAL_APPROVED = 'Approved';

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
    mockAppealFindMany.mockResolvedValue([
      {
        id: 555,
        entityId: 128489949,
        entityType: ENTITY_IMAGE,
        userId: 1,
        buzzTransactionId: null,
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
});
