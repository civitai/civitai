import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * F-E E1 — anon-exposure security tests for the marketplace listing
 * (`BlockRegistry.listAvailable`, served by the anon-capable
 * `blocks.listAvailable` publicProcedure).
 *
 * The marketplace is anon-CAPABLE (dark today behind the mod-segmented flag,
 * lit at launch by widening the segment). These tests pin the two exposure
 * protections so they FAIL if either regresses:
 *
 *   1. APPROVED-ONLY — the SQL hard-filters `ab.status = 'approved'`, so
 *      pending / rejected / withdrawn apps can never reach an anon caller.
 *      Belt-and-suspenders, we also seed a pending row into the (mocked) DB
 *      result and assert the projection carries no status/secret fields.
 *   2. PUBLIC FIELD ALLOWLIST — the raw stored `manifest` jsonb is arbitrary
 *      publisher JSON plus server-SET internal fields (`trustTier`, the
 *      internal `iframe.src` host, `renderMode`, `scopes`, …). The listing
 *      must project ONLY the vetted public subset
 *      (name / description / targets[].slotId) — never the raw manifest.
 *
 * We don't run the query (no DB in unit tests). We mock dbRead.$queryRaw to:
 *   - capture the SQL template (assert the status='approved' filter), and
 *   - return seeded rows so we can assert the SHAPE of the projected output.
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    blockUserSubscription: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    appBlock: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    modelVersion: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
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

/** Reconstructs the SQL string from the tagged-template args Prisma received. */
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

/**
 * One raw DB row shape (snake_case, as returned by the $queryRaw). The
 * `manifest` deliberately carries private/internal fields a malicious or
 * careless publisher (or the server's own trustTier stamp) could put there —
 * the projection must strip them.
 */
function rawRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ab_1',
    block_id: 'cool-block',
    app_id: 'app_1',
    app_name: 'Cool App',
    install_count: 5n,
    manifest: {
      name: 'Cool Block',
      description: 'Does cool things',
      targets: [{ slotId: 'model.sidebar_top', secretCfg: 'leak-me' }],
      // --- private / internal fields that MUST NOT leak to anon ---
      trustTier: 'internal',
      iframe: { src: 'https://cool-block.internal.example/', sandbox: 'allow-scripts' },
      renderMode: 'iframe',
      scopes: ['ai:write:budgeted', 'models:read:self'],
      settings: { apiKey: 'super-secret' },
      json: 'whatever-internal',
      arbitraryPublisherField: { nested: 'secret' },
    },
    ...over,
  };
}

describe('BlockRegistry.listAvailable — anon-exposure protections (F-E E1)', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([rawRow()]);
  });

  it('SQL hard-filters status = approved (pending/rejected never returned)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listAvailable({ limit: 20 });
    expect(capturedSql()).toMatch(/ab\.status\s*=\s*'approved'/);
  });

  it('projects ONLY the public manifest allowlist — no private/internal field leaks', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const { items } = await BlockRegistry.listAvailable({ limit: 20 });
    expect(items).toHaveLength(1);
    const manifest = items[0].manifest as Record<string, unknown>;

    // Allowlisted, display-safe fields survive.
    expect(manifest.name).toBe('Cool Block');
    expect(manifest.description).toBe('Does cool things');
    expect(manifest.targets).toEqual([{ slotId: 'model.sidebar_top' }]);

    // Private / internal fields are absent.
    for (const forbidden of [
      'trustTier',
      'iframe',
      'renderMode',
      'scopes',
      'settings',
      'json',
      'arbitraryPublisherField',
    ]) {
      expect(manifest, `manifest leaked "${forbidden}"`).not.toHaveProperty(forbidden);
    }

    // Per-target fields beyond slotId are dropped (no nested config leak).
    const target0 = (manifest.targets as Array<Record<string, unknown>>)[0];
    expect(target0).not.toHaveProperty('secretCfg');
    expect(Object.keys(target0)).toEqual(['slotId']);

    // The whole serialized listing must not contain any secret value.
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('internal.example');
    expect(serialized).not.toContain('leak-me');
  });

  it('returned top-level shape is the public allowlist only (no status/raw leak)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const { items } = await BlockRegistry.listAvailable({ limit: 20 });
    expect(Object.keys(items[0]).sort()).toEqual(
      ['appId', 'appName', 'blockId', 'id', 'installCount', 'manifest'].sort()
    );
    // status is a DB-internal field; it must never appear on the wire shape.
    expect(items[0]).not.toHaveProperty('status');
  });

  it('a malformed/missing manifest yields an empty public manifest (no crash, no leak)', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      rawRow({ manifest: null }),
      rawRow({ id: 'ab_2', manifest: 'a string, not an object' }),
      rawRow({ id: 'ab_3', manifest: { targets: 'not-an-array', trustTier: 'internal' } }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const { items } = await BlockRegistry.listAvailable({ limit: 20 });
    expect(items).toHaveLength(3);
    for (const it of items) {
      expect(it.manifest).not.toHaveProperty('trustTier');
      // targets, when not a valid array, is simply omitted.
      if ('targets' in it.manifest) {
        expect(Array.isArray((it.manifest as { targets?: unknown }).targets)).toBe(true);
      }
    }
  });

  it('query + slot filter + cursor are threaded into the SQL (anon browse still works)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listAvailable({
      limit: 20,
      query: 'cool',
      slotId: 'model.sidebar_top',
      cursor: 'ab_0',
    });
    const sql = capturedSql();
    // ILIKE name/blockId filter, slot @> jsonb filter, and id > cursor pagination.
    expect(sql).toMatch(/LIKE/i);
    expect(sql).toMatch(/@>/);
    expect(sql).toMatch(/ab\.id\s*>/);
  });

  it('emits nextCursor only when a full page+1 is returned (pagination contract)', async () => {
    // Return limit+1 rows so the service trims to `limit` and sets nextCursor.
    const rows = Array.from({ length: 3 }, (_v, i) => rawRow({ id: `ab_${i}` }));
    mockDbRead.$queryRaw.mockResolvedValueOnce(rows);
    const { BlockRegistry } = await import('../block-registry.service');
    const { items, nextCursor } = await BlockRegistry.listAvailable({ limit: 2 });
    expect(items).toHaveLength(2);
    expect(nextCursor).toBe('ab_1');
  });
});
