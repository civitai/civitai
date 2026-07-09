import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * F-E E4 — service tests for curation:
 *   - `BlockRegistry.getFeaturedBlocks` (anon-capable featured rail).
 *   - `BlockRegistry.setMarketplaceMeta` (MOD-ONLY curation write).
 *   - `BlockRegistry.getMarketplaceMeta` (MOD-ONLY seed read).
 *
 * The featured rail is anon-CAPABLE (dark today behind the mod-segmented flag),
 * so its exposure protections are pinned the same way E1/E2/E3 pin theirs — the
 * tests FAIL if the projection widens or the approved+featured filter regresses.
 *
 * setMarketplaceMeta is mod-only at the ROUTER (covered by the router test); the
 * SERVICE tests pin the data-integrity rules it enforces regardless of caller:
 * off-taxonomy categories are rejected, featuring is approved-only, and only the
 * provided fields are written (a patch, not a full overwrite).
 *
 * No DB in unit tests: dbRead/dbWrite are mocked. We capture the featured SQL +
 * the write `data` to assert the SHAPE.
 */

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    appBlock: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
    },
    blockUserSubscription: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    modelVersion: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => 0),
    scanIterator: async function* () {},
  },
  sysRedis: { sMembers: vi.fn(async () => []) },
  REDIS_KEYS: {
    BLOCKS: { REGISTRY: 'packed:caches:block-registry', TOKEN_RATE_LIMIT: 'rl', REVOKED_INSTANCE: 'rev' },
  },
  REDIS_SYS_KEYS: { BLOCKS: { EMERGENCY_KILL_LIST: 'kill' } },
}));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai', LOGGING: '' } }));

function capturedSql(): string {
  expect(mockDb.$queryRaw).toHaveBeenCalled();
  const lastCall = mockDb.$queryRaw.mock.calls.at(-1);
  if (!lastCall) return '';
  const first = lastCall[0] as unknown;
  if (first && typeof first === 'object' && typeof (first as { sql?: unknown }).sql === 'string') {
    return (first as { sql: string }).sql;
  }
  const strings = first as unknown as TemplateStringsArray;
  const values = lastCall.slice(1);
  let sql = '';
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i];
    if (i < values.length) sql += `$${i + 1}`;
  }
  return sql;
}

/** One raw featured-rail row (snake_case), carrying private manifest fields the
 * projection must strip. */
function featuredRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ab_1',
    block_id: 'cool-block',
    app_id: 'app_1',
    app_name: 'Cool App',
    install_count: 9n,
    category: 'games',
    approved_scopes: ['ai:write:budgeted', 'models:read:self', 'buzz:read:self', 'social:tip:self'],
    avg_rating: 4.7,
    review_count: 21n,
    manifest: {
      name: 'Cool Block',
      description: 'Does cool things',
      targets: [{ slotId: 'model.sidebar_top', secretCfg: 'leak-me' }],
      trustTier: 'internal',
      iframe: { src: 'https://cool-block.internal.example/' },
      renderMode: 'iframe',
      scopes: ['INTERNAL_secret_scope'],
      settings: { apiKey: 'super-secret' },
    },
    ...over,
  };
}

describe('BlockRegistry.getFeaturedBlocks — featured rail exposure (F-E E4)', () => {
  beforeEach(() => {
    mockDb.$queryRaw.mockClear();
    mockDb.$queryRaw.mockResolvedValue([featuredRow()]);
  });

  it('SQL hard-filters status=approved AND featured=true (only curated approved apps)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.getFeaturedBlocks(12);
    const sql = capturedSql();
    expect(sql).toMatch(/ab\.status\s*=\s*'approved'/);
    expect(sql).toMatch(/ab\.featured\s*=\s*true/);
  });

  it('orders by featured_order ASC NULLS LAST then a deterministic tiebreak', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.getFeaturedBlocks(12);
    const sql = capturedSql();
    expect(sql).toMatch(/ORDER BY\s+ab\.featured_order\s+ASC\s+NULLS\s+LAST/i);
    // install_count is the tiebreak, ab.id the final total order.
    expect(sql).toMatch(/install_count\s+DESC/i);
    expect(sql).toMatch(/ab\.id\s+ASC/i);
  });

  it('projects ONLY the public AvailableBlock allowlist — no private/internal leak', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const items = await BlockRegistry.getFeaturedBlocks(12);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        'appId',
        'appName',
        'avgRating',
        'blockId',
        'category',
        'coverUrl',
        'externalUrl',
        'id',
        'installCount',
        'manifest',
        'reviewCount',
        'scopesSummary',
      ].sort()
    );
    const manifest = item.manifest as Record<string, unknown>;
    expect(manifest.name).toBe('Cool Block');
    expect(manifest.description).toBe('Does cool things');
    expect(manifest.targets).toEqual([{ slotId: 'model.sidebar_top' }]);
    for (const forbidden of ['trustTier', 'iframe', 'renderMode', 'scopes', 'settings']) {
      expect(manifest, `manifest leaked "${forbidden}"`).not.toHaveProperty(forbidden);
    }
    // The whole serialized rail carries no secret value (mutation-test).
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('internal.example');
    expect(serialized).not.toContain('leak-me');
    expect(serialized).not.toContain('INTERNAL_secret_scope');
  });

  it('scopesSummary comes from approved_scopes (capped), category passes through', async () => {
    const { BlockRegistry, MARKETPLACE_SCOPES_SUMMARY_LIMIT } = await import(
      '../block-registry.service'
    );
    const items = await BlockRegistry.getFeaturedBlocks(12);
    expect(items[0].scopesSummary).toEqual(
      ['ai:write:budgeted', 'models:read:self', 'buzz:read:self', 'social:tip:self'].slice(
        0,
        MARKETPLACE_SCOPES_SUMMARY_LIMIT
      )
    );
    expect(items[0].category).toBe('games');
  });

  it('a NULL approved_scopes / malformed manifest do not crash or leak', async () => {
    mockDb.$queryRaw.mockResolvedValueOnce([
      featuredRow({ approved_scopes: null, manifest: null }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const items = await BlockRegistry.getFeaturedBlocks(12);
    expect(items[0].scopesSummary).toEqual([]);
    expect(items[0].manifest).toEqual({});
  });
});

describe('BlockRegistry.setMarketplaceMeta — data-integrity rules (F-E E4)', () => {
  beforeEach(() => {
    mockDb.appBlock.findUnique.mockReset();
    mockDb.appBlock.update.mockReset();
    mockDb.appBlock.update.mockResolvedValue({
      id: 'ab_1',
      status: 'approved',
      category: 'games',
      featured: true,
      featuredOrder: 3,
    });
  });

  it('rejects an off-taxonomy category before any write (defense-in-depth)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await expect(
      BlockRegistry.setMarketplaceMeta({
        appBlockId: 'ab_1',
        // @ts-expect-error — deliberately invalid; the service belt must reject.
        category: 'totally-made-up',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.appBlock.update).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND for a missing app (no write)', async () => {
    mockDb.appBlock.findUnique.mockResolvedValueOnce(null);
    const { BlockRegistry } = await import('../block-registry.service');
    await expect(
      BlockRegistry.setMarketplaceMeta({ appBlockId: 'missing', featured: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDb.appBlock.update).not.toHaveBeenCalled();
  });

  it('REFUSES to feature a non-approved app (no write)', async () => {
    for (const status of ['pending', 'rejected', 'withdrawn', 'disabled']) {
      mockDb.appBlock.findUnique.mockResolvedValueOnce({ id: 'ab_1', status });
      const { BlockRegistry } = await import('../block-registry.service');
      await expect(
        BlockRegistry.setMarketplaceMeta({ appBlockId: 'ab_1', featured: true }),
        `status="${status}" must not be featurable`
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(mockDb.appBlock.update).not.toHaveBeenCalled();
  });

  it('ALLOWS featuring an approved app, writing the expected fields', async () => {
    mockDb.appBlock.findUnique.mockResolvedValueOnce({ id: 'ab_1', status: 'approved' });
    const { BlockRegistry } = await import('../block-registry.service');
    const result = await BlockRegistry.setMarketplaceMeta({
      appBlockId: 'ab_1',
      category: 'games',
      featured: true,
      featuredOrder: 3,
    });
    expect(mockDb.appBlock.update).toHaveBeenCalledTimes(1);
    const call = mockDb.appBlock.update.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: 'ab_1' });
    expect(call.data).toEqual({ category: 'games', featured: true, featuredOrder: 3 });
    expect(result).toMatchObject({ appBlockId: 'ab_1', featured: true, category: 'games' });
  });

  it('is a PATCH — only the provided fields are written (omitted = unchanged)', async () => {
    mockDb.appBlock.findUnique.mockResolvedValueOnce({ id: 'ab_1', status: 'approved' });
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.setMarketplaceMeta({ appBlockId: 'ab_1', featured: false });
    const call = mockDb.appBlock.update.mock.calls[0][0] as { data: Record<string, unknown> };
    // category + featuredOrder were NOT provided → not in the write data.
    expect(call.data).toEqual({ featured: false });
    expect(call.data).not.toHaveProperty('category');
    expect(call.data).not.toHaveProperty('featuredOrder');
  });

  it('allows explicitly CLEARING category/order with null (a non-approved app can be un-featured/edited)', async () => {
    mockDb.appBlock.findUnique.mockResolvedValueOnce({ id: 'ab_1', status: 'pending' });
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.setMarketplaceMeta({
      appBlockId: 'ab_1',
      category: null,
      featuredOrder: null,
      featured: false, // un-feature is allowed on a non-approved app
    });
    const call = mockDb.appBlock.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data).toEqual({ category: null, featuredOrder: null, featured: false });
  });

  it('E4 Low-2: the service writes ONLY its allowlisted fields even if extra keys reach it (mass-assignment guard, independent of the router zod strip)', async () => {
    mockDb.appBlock.findUnique.mockResolvedValueOnce({ id: 'ab_1', status: 'approved' });
    const { BlockRegistry } = await import('../block-registry.service');
    // Call the service DIRECTLY (bypassing the router's zod object that would
    // strip unknown keys) with attacker-controlled protected columns. The
    // service's own `data` allowlist must drop them — only `featured` is written.
    await BlockRegistry.setMarketplaceMeta({
      appBlockId: 'ab_1',
      featured: true,
      status: 'rejected',
      trustTier: 'internal',
      manifest: { evil: true },
      approvedScopes: ['*'],
    } as never);
    const call = mockDb.appBlock.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data).toEqual({ featured: true });
    for (const k of ['status', 'trustTier', 'manifest', 'approvedScopes', 'appBlockId']) {
      expect(call.data).not.toHaveProperty(k);
    }
  });
});

describe('BlockRegistry.getMarketplaceMeta — mod seed read (F-E E4)', () => {
  beforeEach(() => {
    mockDb.appBlock.findUnique.mockReset();
  });

  it('returns the current meta for an existing app', async () => {
    mockDb.appBlock.findUnique.mockResolvedValueOnce({
      id: 'ab_1',
      status: 'approved',
      category: 'utility',
      featured: true,
      featuredOrder: 2,
    });
    const { BlockRegistry } = await import('../block-registry.service');
    expect(await BlockRegistry.getMarketplaceMeta('ab_1')).toEqual({
      appBlockId: 'ab_1',
      status: 'approved',
      category: 'utility',
      featured: true,
      featuredOrder: 2,
    });
  });

  it('returns null for a missing app', async () => {
    mockDb.appBlock.findUnique.mockResolvedValueOnce(null);
    const { BlockRegistry } = await import('../block-registry.service');
    expect(await BlockRegistry.getMarketplaceMeta('missing')).toBeNull();
  });
});
