import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pins the listForModel SQL invariants that no static-analysis test could
 * catch. We don't run the query (no DB in unit tests) — we capture the SQL
 * template literal that's passed to dbRead.$queryRaw and assert on its shape.
 *
 * Two invariants from the audit's call-outs:
 *   1. NOT EXISTS subquery against model_block_installs filters on
 *      (model_id, app_block_id, slot_id) — and crucially NOT on `enabled`.
 *      Including `enabled = true` would silently break publisher opt-out
 *      (toggleEnabled(false) keeps the row; the NOT EXISTS must see it).
 *   2. The installs branch DOES filter on `mbi.enabled = TRUE` (without
 *      this, disabled installs would render).
 */

const { mockDbRead, mockDbWrite, mockRedis, mockSysRedis } = vi.hoisted(() => {
  const dbRead = {
    $queryRaw: vi.fn(async () => []),
    modelBlockInstall: { findUnique: vi.fn() },
    appBlock: { findUnique: vi.fn() },
  };
  const dbWrite = {
    appBlock: { findUnique: vi.fn() },
    modelBlockInstall: {
      upsert: vi.fn(async () => ({ blockInstanceId: 'bki_test' })),
      deleteMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
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

  it('installs branch filters on mbi.enabled = TRUE', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.sidebar_top' });
    const sql = capturedSql();
    expect(sql).toMatch(/mbi\.enabled\s*=\s*TRUE/);
  });

  it('installs branch filters on mbi.slot_id (audit C4)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.sidebar_top' });
    expect(capturedSql()).toMatch(/mbi\.slot_id\s*=\s*\$\d+/);
  });

  it('NOT EXISTS subquery does NOT filter on enabled (publisher opt-out invariant)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({ modelId: 1, slotId: 'model.sidebar_top' });
    const sql = capturedSql();
    // Locate the NOT EXISTS block and assert no `enabled` clause inside it.
    const notExistsMatch = sql.match(/NOT EXISTS\s*\(([\s\S]*?)\)/i);
    expect(notExistsMatch).toBeTruthy();
    if (notExistsMatch) {
      expect(notExistsMatch[1]).not.toMatch(/\benabled\b/);
      // …but it should still filter on the tuple keys.
      expect(notExistsMatch[1]).toMatch(/model_id/);
      expect(notExistsMatch[1]).toMatch(/app_block_id/);
      expect(notExistsMatch[1]).toMatch(/slot_id/);
    }
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
});

describe('BlockRegistry.installOnModel preserves settings on omit (audit M2)', () => {
  beforeEach(() => {
    mockDbWrite.appBlock.findUnique.mockResolvedValue({ status: 'approved' });
    (mockDbWrite.modelBlockInstall as unknown as { findMany: ReturnType<typeof vi.fn> }).findMany =
      vi.fn(async () => []);
    mockDbWrite.modelBlockInstall.upsert.mockClear();
    mockDbWrite.modelBlockInstall.upsert.mockResolvedValue({ blockInstanceId: 'bki_test' });
  });

  it('omits settings from the upsert update payload when caller omits', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.installOnModel({
      modelId: 1,
      appBlockId: 'ab_test',
      slotId: 'model.sidebar_top',
      installedByUserId: 42,
    });
    const upsertArgs = mockDbWrite.modelBlockInstall.upsert.mock.calls.at(-1)?.[0] as {
      update: { settings?: unknown };
    };
    expect(upsertArgs.update).not.toHaveProperty('settings');
  });

  it('includes settings in the upsert update payload when caller passes them', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.installOnModel({
      modelId: 1,
      appBlockId: 'ab_test',
      slotId: 'model.sidebar_top',
      installedByUserId: 42,
      settings: { foo: 'bar' },
    });
    const upsertArgs = mockDbWrite.modelBlockInstall.upsert.mock.calls.at(-1)?.[0] as {
      update: { settings?: unknown };
    };
    expect(upsertArgs.update).toHaveProperty('settings', { foo: 'bar' });
  });
});

describe('BlockRegistry.installOnModel enforces MAX_BLOCKS_PER_SLOT (audit H-4)', () => {
  beforeEach(() => {
    mockDbWrite.appBlock.findUnique.mockResolvedValue({ status: 'approved' });
    mockDbWrite.modelBlockInstall.upsert.mockClear();
    mockDbWrite.modelBlockInstall.upsert.mockResolvedValue({ blockInstanceId: 'bki_new' });
  });

  it('rejects the 4th distinct install in a slot', async () => {
    (mockDbWrite.modelBlockInstall as unknown as { findMany: ReturnType<typeof vi.fn> }).findMany =
      vi.fn(async () => [
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
    expect(mockDbWrite.modelBlockInstall.upsert).not.toHaveBeenCalled();
  });

  it('allows a re-install of an existing block at the cap (no new row)', async () => {
    (mockDbWrite.modelBlockInstall as unknown as { findMany: ReturnType<typeof vi.fn> }).findMany =
      vi.fn(async () => [
        { appBlockId: 'ab_one' },
        { appBlockId: 'ab_two' },
        { appBlockId: 'ab_three' },
      ]);
    const { BlockRegistry } = await import('../block-registry.service');
    // Re-installing ab_two at the cap is fine — it's already an existing
    // install row; the upsert hits the update branch, doesn't grow the count.
    await expect(
      BlockRegistry.installOnModel({
        modelId: 1,
        appBlockId: 'ab_two',
        slotId: 'model.sidebar_top',
        installedByUserId: 42,
      })
    ).resolves.toEqual({ blockInstanceId: 'bki_new' });
    expect(mockDbWrite.modelBlockInstall.upsert).toHaveBeenCalled();
  });
});

describe('BlockRegistry.toggleEnabled revocation cycle (audit B1)', () => {
  beforeEach(() => {
    (mockDbWrite.modelBlockInstall as unknown as { update: ReturnType<typeof vi.fn> }).update =
      vi.fn(async () => ({ blockInstanceId: 'bki_test' }));
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
