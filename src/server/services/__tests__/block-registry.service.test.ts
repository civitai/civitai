import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pins the listForModel SQL invariants that no static-analysis test could
 * catch. We don't run the query (no DB in unit tests) — we capture the SQL
 * template literal that's passed to dbRead.$queryRaw and assert on its shape.
 *
 * Post 2026-05-30 kill_per_model_installs migration:
 *   - per-model installs are now `block_user_subscriptions` rows with
 *     slot_id non-NULL and target_model_ids containing the modelId
 *   - publisher opt-out semantics are preserved: the NOT EXISTS clause
 *     against the pinned shape ignores `enabled`, so toggleEnabled(false)
 *     on a pinned sub still suppresses blanket + platform-default
 *   - the blanket publisher subscription branch additionally requires
 *     slot_id IS NULL and cardinality(target_model_ids) = 0 so it can't
 *     collide with the pinned branch
 */

const { mockDbRead, mockDbWrite, mockRedis, mockSysRedis } = vi.hoisted(() => {
  // Annotate Promise<any[] | any> on the impl so `.mockResolvedValue({...})`
  // / `.mockResolvedValue([{...}, ...])` at call sites isn't narrowed to
  // `Promise<never>` by vi.fn's overload inference.
  // Type the impl so vi.fn captures both args AND return type — needed so
  // `.mock.calls.at(-1)?.[0]` doesn't narrow to `never` and
  // `.mockResolvedValue({...})` accepts arbitrary objects.
  const dbRead = {
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    blockUserSubscription: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    appBlock: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    modelVersion: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) },
  };
  const dbWrite = {
    appBlock: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    blockUserSubscription: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ blockInstanceId: 'bki_test' })),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
      deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
    // A6: installOnModel now writes an implicit-consent grant via
    // recordInstallConsent → recordScopeGrant.
    appUserScopeGrant: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
    },
  };
  const redis = {
    packed: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => 0),
    scanIterator: async function* () {},
  };
  const sysRedis = { sMembers: vi.fn(async () => []) };
  return { mockDbRead: dbRead, mockDbWrite: dbWrite, mockRedis: redis, mockSysRedis: sysRedis };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  sysRedis: mockSysRedis,
  REDIS_KEYS: {
    BLOCKS: {
      REGISTRY: 'packed:caches:block-registry',
      TOKEN_RATE_LIMIT: 'rl',
      REVOKED_INSTANCE: 'rev',
    },
  },
  REDIS_SYS_KEYS: { BLOCKS: { EMERGENCY_KILL_LIST: 'kill' } },
}));

describe('BlockRegistry.listForModel SQL invariants', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([]);
  });

  /**
   * Reconstructs the SQL string from the template literal Prisma's tagged
   * template passes to $queryRaw. Prisma receives (strings, ...values); we
   * stitch them with placeholders for assertion.
   */
  function capturedSql(): string {
    expect(mockDbRead.$queryRaw).toHaveBeenCalled();
    const lastCall = mockDbRead.$queryRaw.mock.calls.at(-1);
    if (!lastCall) return '';
    const strings = lastCall[0] as unknown as TemplateStringsArray;
    const values = lastCall.slice(1);
    let sql = '';
    for (let i = 0; i < strings.length; i++) {
      sql += strings[i];
      if (i < values.length) sql += `$${i + 1}`;
    }
    return sql;
  }

  it('pinned-subscription branch filters on bus.enabled = TRUE', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.sidebar_top' });
    const sql = capturedSql();
    expect(sql).toMatch(/bus\.enabled\s*=\s*TRUE/);
  });

  it('pinned-subscription branch filters on bus.slot_id (audit C4)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.sidebar_top' });
    expect(capturedSql()).toMatch(/bus\.slot_id\s*=\s*\$\d+/);
  });

  it('NOT EXISTS subquery does NOT filter on enabled (publisher opt-out invariant)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.sidebar_top' });
    const sql = capturedSql();
    // Find every NOT EXISTS body; the suppression subqueries that mirror
    // the historical "publisher opt-out" path must not gate on enabled.
    const all = sql.matchAll(/NOT EXISTS\s*\(([\s\S]*?)\)/gi);
    let saw = 0;
    for (const m of all) {
      saw++;
      // Each suppression looks up the pinned sub by (slot, app, target_model
      // _ids). It should not filter on enabled.
      if (m[1].includes('pin.scope') || m[1].includes('pub.scope')) {
        // Allow `pub.enabled = TRUE` on the rank-4 viewer-side suppression
        // for blanket publisher subs — that branch genuinely doesn't want
        // to suppress when the publisher's blanket sub is disabled.
        // The pinned-sub suppression (`pin.scope = publisher_all_my_models`
        // AND slot_id = X AND target_model_ids has modelId) must NOT gate.
        if (m[1].includes('pin.scope')) {
          expect(m[1]).not.toMatch(/\benabled\b/);
        }
      }
    }
    expect(saw).toBeGreaterThan(0);
  });

  it('platform defaults branch filters on pdb.slot_id and pdb.enabled', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.below_images' });
    const sql = capturedSql();
    expect(sql).toMatch(/pdb\.slot_id\s*=\s*\$\d+/);
    expect(sql).toMatch(/pdb\.enabled\s*=\s*TRUE/);
  });

  it('limits results to 3 per slot', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.sidebar_top' });
    expect(capturedSql()).toMatch(/LIMIT\s+\$\d+/);
  });

  it('pinned-subscription branch requires modelId in target_model_ids', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 2522512, slotId: 'model.sidebar_top' });
    const sql = capturedSql();
    expect(sql).toMatch(/\$\d+\s*=\s*ANY\(bus\.target_model_ids\)/);
  });

  it('blanket publisher-sub branch requires slot_id IS NULL and empty target_model_ids', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.sidebar_top' });
    const sql = capturedSql();
    // The rank-2 SELECT must explicitly check both predicates.
    expect(sql).toMatch(/bus\.slot_id\s+IS\s+NULL/);
    expect(sql).toMatch(/cardinality\(bus\.target_model_ids\)\s*=\s*0/);
  });
});

describe('BlockRegistry.installOnModel preserves settings on omit (audit M2)', () => {
  beforeEach(() => {
    mockDbWrite.appBlock.findUnique.mockResolvedValue({
      status: 'approved',
      blockId: 'g',
      manifest: {},
      approvedScopes: [],
    });
    mockDbWrite.blockUserSubscription.findMany.mockReset();
    mockDbWrite.blockUserSubscription.findMany.mockResolvedValue([]);
    mockDbWrite.blockUserSubscription.findFirst.mockReset();
    mockDbWrite.blockUserSubscription.create.mockReset();
    mockDbWrite.blockUserSubscription.update.mockReset();
  });

  it('omits settings from the update payload when caller omits AND row exists', async () => {
    // Existing row: take the update branch.
    mockDbWrite.blockUserSubscription.findFirst.mockResolvedValue({
      id: 'bus_existing',
      blockInstanceId: 'bki_existing',
    });
    mockDbWrite.blockUserSubscription.update.mockResolvedValue({});
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.installOnModel({
      modelId: 1,
      appBlockId: 'ab_test',
      slotId: 'model.sidebar_top',
      installedByUserId: 42,
    });
    const args = mockDbWrite.blockUserSubscription.update.mock.calls.at(-1)?.[0] as {
      data: { settings?: unknown };
    };
    expect(args.data).not.toHaveProperty('settings');
  });

  it('includes settings in the update payload when caller passes them', async () => {
    // Manifest must declare `foo` as a settings field, otherwise the
    // generic validator strips it (correctly — unknown fields are not
    // allowlisted for storage). Mirror what a real manifest looks like.
    mockDbWrite.appBlock.findUnique.mockResolvedValue({
      status: 'approved',
      blockId: 'g',
      manifest: {
        settings: { foo: { type: 'string', scope: 'publisher', label: 'Foo' } },
      },
      approvedScopes: [],
    });
    mockDbWrite.blockUserSubscription.findFirst.mockResolvedValue({
      id: 'bus_existing',
      blockInstanceId: 'bki_existing',
    });
    mockDbWrite.blockUserSubscription.update.mockResolvedValue({});
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.installOnModel({
      modelId: 1,
      appBlockId: 'ab_test',
      slotId: 'model.sidebar_top',
      installedByUserId: 42,
      settings: { foo: 'bar' },
    });
    const args = mockDbWrite.blockUserSubscription.update.mock.calls.at(-1)?.[0] as {
      data: { settings?: unknown };
    };
    expect(args.data).toHaveProperty('settings', { foo: 'bar' });
  });
});

describe('BlockRegistry.installOnModel enforces MAX_BLOCKS_PER_SLOT (audit H-4)', () => {
  beforeEach(() => {
    mockDbWrite.appBlock.findUnique.mockResolvedValue({
      status: 'approved',
      blockId: 'g',
      manifest: {},
      approvedScopes: [],
    });
    mockDbWrite.blockUserSubscription.findMany.mockReset();
    mockDbWrite.blockUserSubscription.findFirst.mockReset();
    mockDbWrite.blockUserSubscription.create.mockReset();
    mockDbWrite.blockUserSubscription.update.mockReset();
  });

  it('rejects the 4th distinct install in a slot', async () => {
    mockDbWrite.blockUserSubscription.findMany.mockResolvedValue([
      { appBlockId: 'ab_one' },
      { appBlockId: 'ab_two' },
      { appBlockId: 'ab_three' },
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    await expect(
      BlockRegistry.installOnModel({
        modelId: 1,
        appBlockId: 'ab_four',
        slotId: 'model.sidebar_top',
        installedByUserId: 42,
      })
    ).rejects.toThrow();
    expect(mockDbWrite.blockUserSubscription.create).not.toHaveBeenCalled();
    expect(mockDbWrite.blockUserSubscription.update).not.toHaveBeenCalled();
  });

  it('allows a re-install of an existing block at the cap (no new row)', async () => {
    mockDbWrite.blockUserSubscription.findMany.mockResolvedValue([
      { appBlockId: 'ab_one' },
      { appBlockId: 'ab_two' },
      { appBlockId: 'ab_three' },
    ]);
    // The (user, app, scope, slot, model) row exists → update branch.
    mockDbWrite.blockUserSubscription.findFirst.mockResolvedValue({
      id: 'bus_existing',
      blockInstanceId: 'bki_existing',
    });
    mockDbWrite.blockUserSubscription.update.mockResolvedValue({});
    const { BlockRegistry } = await import('../block-registry.service');
    const out = await BlockRegistry.installOnModel({
      modelId: 1,
      appBlockId: 'ab_two',
      slotId: 'model.sidebar_top',
      installedByUserId: 42,
    });
    expect(out.blockInstanceId).toBe('bki_existing');
    expect(mockDbWrite.blockUserSubscription.update).toHaveBeenCalled();
    expect(mockDbWrite.blockUserSubscription.create).not.toHaveBeenCalled();
  });
});

describe('BlockRegistry.toggleEnabled revocation cycle (audit B1)', () => {
  beforeEach(() => {
    mockDbWrite.blockUserSubscription.findMany.mockReset();
    mockDbWrite.blockUserSubscription.findMany.mockResolvedValue([
      { id: 'bus_test', blockInstanceId: 'bki_test' },
    ]);
    mockDbWrite.blockUserSubscription.update.mockResolvedValue({});
  });

  it('toggleEnabled(false) writes the revocation marker', async () => {
    const setMock = vi.fn(async () => undefined);
    const delMock = vi.fn(async () => 0);
    mockRedis.set = setMock as never;
    mockRedis.del = delMock as never;
    mockRedis.get = vi.fn(async () => null);

    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.toggleEnabled({
      modelId: 1,
      appBlockId: 'ab',
      slotId: 'model.sidebar_top',
      enabled: false,
    });
    expect(setMock).toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
  });

  it('toggleEnabled(true) CLEARS the revocation marker (B1 regression)', async () => {
    // Pre-condition: marker is set in Redis (a prior disable wrote it).
    const setMock = vi.fn(async () => undefined);
    const delMock = vi.fn(async () => 1);
    mockRedis.set = setMock as never;
    mockRedis.del = delMock as never;

    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.toggleEnabled({
      modelId: 1,
      appBlockId: 'ab',
      slotId: 'model.sidebar_top',
      enabled: true,
    });
    // Without the B1 fix, this assertion fails — the marker would persist
    // and 403 every token for 15 minutes.
    expect(delMock).toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe('BlockRegistry.listForModel publisherSettings projection (audit H-3)', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockReset();
  });

  it('drops settings keys not in manifest.publicSettingsKeys', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([
      {
        block_instance_id: 'bki_x',
        block_id: 'blk_x',
        app_id: 'app',
        manifest: {
          publicSettingsKeys: ['theme'],
          iframe: { src: 'https://blocks.civitai.com/x' },
        },
        settings: {
          theme: 'dark',
          internalCustomerId: 'cus_secret', // must NOT leak
        },
        enabled: true,
        render_mode: 'iframe',
        trust_tier: 'unverified',
        manifest_render_mode: null,
      },
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const result = await BlockRegistry.listForModel({
      modelId: 1,
      slotId: 'model.sidebar_top',
      modelNsfwLevel: 8,
    });
    expect(result[0].publisherSettings).toEqual({ theme: 'dark' });
    expect(result[0].publisherSettings).not.toHaveProperty('internalCustomerId');
  });

  it('fails closed when manifest.publicSettingsKeys is missing', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([
      {
        block_instance_id: 'bki_x',
        block_id: 'blk_x',
        app_id: 'app',
        manifest: { iframe: { src: 'https://blocks.civitai.com/x' } },
        settings: { theme: 'dark', anything: 'else' },
        enabled: true,
        render_mode: 'iframe',
        trust_tier: 'unverified',
        manifest_render_mode: null,
      },
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const result = await BlockRegistry.listForModel({
      modelId: 1,
      slotId: 'model.sidebar_top',
      modelNsfwLevel: 8,
    });
    expect(result[0].publisherSettings).toEqual({});
  });
});

describe('BlockRegistry.listForModel content-rating filter (audit I15)', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockResolvedValue([
      {
        block_instance_id: 'bki_g',
        block_id: 'blk_g',
        app_id: 'app',
        manifest: { contentRating: 'g', iframe: { src: 'https://blocks.civitai.com/g' } },
        settings: {},
        enabled: true,
        render_mode: 'iframe',
        trust_tier: 'unverified',
        manifest_render_mode: null,
      },
      {
        block_instance_id: 'bki_x',
        block_id: 'blk_x',
        app_id: 'app',
        manifest: { contentRating: 'x', iframe: { src: 'https://blocks.civitai.com/x' } },
        settings: {},
        enabled: true,
        render_mode: 'iframe',
        trust_tier: 'unverified',
        manifest_render_mode: null,
      },
    ]);
  });

  it('drops x-rated blocks on a pg model page', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const result = await BlockRegistry.listForModel({
      modelId: 1,
      slotId: 'model.sidebar_top',
      modelNsfwLevel: 1, // 'pg'
    });
    expect(result.map((r) => r.blockId)).toEqual(['blk_g']);
  });

  it('keeps x-rated blocks on a x-rated model page', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const result = await BlockRegistry.listForModel({
      modelId: 1,
      slotId: 'model.sidebar_top',
      modelNsfwLevel: 8, // 'x'
    });
    expect(result.map((r) => r.blockId).sort()).toEqual(['blk_g', 'blk_x']);
  });

  it('defaults to most restrictive when nsfw level is omitted', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const result = await BlockRegistry.listForModel({
      modelId: 1,
      slotId: 'model.sidebar_top',
    });
    // pg ceiling — x rejected
    expect(result.map((r) => r.blockId)).toEqual(['blk_g']);
  });
});
