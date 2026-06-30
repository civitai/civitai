import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * NSFW-APP-RED-ONLY — service-level tests for the public marketplace reads
 * (`BlockRegistry.listAvailable` / `getFeaturedBlocks` / `getAppDetail`).
 *
 * A mature-rated app (`content_rating` ∈ {r, x}) is hidden from listings /
 * featured rail and 404s on detail UNLESS the request is on a red-capable host
 * (the router passes `redCapable = isHostForColor(host, 'red')`). SFW apps show
 * everywhere. These tests pin:
 *   - listAvailable / getFeaturedBlocks thread the mature-exclusion SQL into the
 *     query iff !redCapable (and omit it on a red host);
 *   - getAppDetail returns null for a mature app under !redCapable (→ router
 *     NOT_FOUND), and returns it on a red host;
 *   - SFW apps are unaffected by the host gate.
 *
 * Mocks @prisma/client so `Prisma.sql` works without a generated client, and
 * stubs dbRead.$queryRaw to capture the assembled SQL + return seeded rows
 * (same harness idiom as block-registry.page-only-launch.test.ts).
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    blockUserSubscription: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    appBlock: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    modelVersion: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) },
  },
}));

vi.mock('@prisma/client', () => {
  function sql(strings: TemplateStringsArray, ...values: unknown[]) {
    let out = '';
    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i < values.length) {
        const v = values[i];
        out +=
          v && typeof v === 'object' && '__sql' in (v as object)
            ? (v as { __sql: string }).__sql
            : '?';
      }
    }
    return { __sql: out, sql: out, toString: () => out } as unknown as { sql: string };
  }
  return { Prisma: { sql } };
});

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
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai', LOGGING: '' } }));

/** Reconstruct the assembled SQL string from the captured Prisma.sql object. */
function capturedSql(): string {
  expect(mockDbRead.$queryRaw).toHaveBeenCalled();
  const lastCall = mockDbRead.$queryRaw.mock.calls.at(-1);
  if (!lastCall) return '';
  const first = lastCall[0] as unknown;
  if (first && typeof first === 'object' && typeof (first as { sql?: unknown }).sql === 'string') {
    return (first as { sql: string }).sql;
  }
  const strings = first as unknown as TemplateStringsArray;
  const values = lastCall.slice(1);
  let s = '';
  for (let i = 0; i < strings.length; i++) {
    s += strings[i];
    if (i < values.length) {
      const v = values[i];
      s += v && typeof v === 'object' && 'sql' in (v as object) ? (v as { sql: string }).sql : '?';
    }
  }
  return s;
}

// The mature-exclusion fragment matureHostSqlFilter emits when !redCapable.
const MATURE_FILTER_RE = /NOT IN \('r', 'x'\)/;

function listRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ab_1',
    block_id: 'cool-block',
    app_id: 'app_1',
    app_name: 'Cool App',
    install_count: 5n,
    category: 'utility',
    approved_scopes: ['user:read:self'],
    sort_key: '00000000000000000005',
    manifest: { name: 'Cool Block', page: { path: '/run', title: 'Run' } },
    ...over,
  };
}

function detailRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ab_det',
    block_id: 'detail-block',
    app_id: 'app_1',
    app_name: 'Detail App',
    status: 'approved',
    content_rating: 'g',
    version: '1.0.0',
    approved_scopes: ['user:read:self'],
    install_count: 3n,
    screenshots: null,
    // page app by default so the launchOnly gate doesn't interfere
    manifest: { name: 'Detail Block', page: { path: '/run', title: 'Run' } },
    ...over,
  };
}

describe('BlockRegistry — NSFW-app-red-only host gate (public reads)', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([listRow()]);
  });

  describe('listAvailable', () => {
    it('non-red host (redCapable=false) threads the mature-exclusion filter', async () => {
      const { BlockRegistry } = await import('../block-registry.service');
      await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' }, true, false);
      expect(capturedSql()).toMatch(MATURE_FILTER_RE);
    });

    it('red-capable host (redCapable=true) does NOT add the mature filter', async () => {
      const { BlockRegistry } = await import('../block-registry.service');
      await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' }, true, true);
      expect(capturedSql()).not.toMatch(MATURE_FILTER_RE);
    });

    it('default redCapable (omitted) is fail-closed → mature filter present', async () => {
      const { BlockRegistry } = await import('../block-registry.service');
      await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' }, true);
      expect(capturedSql()).toMatch(MATURE_FILTER_RE);
    });
  });

  describe('getFeaturedBlocks', () => {
    it('non-red host threads the mature-exclusion filter', async () => {
      const { BlockRegistry } = await import('../block-registry.service');
      await BlockRegistry.getFeaturedBlocks(12, true, false);
      expect(capturedSql()).toMatch(MATURE_FILTER_RE);
    });

    it('red-capable host does NOT add the mature filter', async () => {
      const { BlockRegistry } = await import('../block-registry.service');
      await BlockRegistry.getFeaturedBlocks(12, true, true);
      expect(capturedSql()).not.toMatch(MATURE_FILTER_RE);
    });
  });

  describe('getAppDetail', () => {
    it('non-red host: a MATURE (x) app resolves to null (→ NOT_FOUND, no leak)', async () => {
      mockDbRead.$queryRaw.mockResolvedValueOnce([detailRow({ content_rating: 'x' })]);
      const { BlockRegistry } = await import('../block-registry.service');
      // launchOnly=false (mod-grandfather) isolates the maturity gate; redCapable=false.
      const detail = await BlockRegistry.getAppDetail('ab_det', false, false);
      expect(detail).toBeNull();
    });

    it('red-capable host: a MATURE (x) app resolves normally', async () => {
      mockDbRead.$queryRaw.mockResolvedValueOnce([detailRow({ content_rating: 'x' })]);
      const { BlockRegistry } = await import('../block-registry.service');
      const detail = await BlockRegistry.getAppDetail('ab_det', false, true);
      expect(detail).not.toBeNull();
      expect(detail?.contentRating).toBe('x');
    });

    it('non-red host: an SFW (g) app resolves normally (host gate only touches mature)', async () => {
      mockDbRead.$queryRaw.mockResolvedValueOnce([detailRow({ content_rating: 'g' })]);
      const { BlockRegistry } = await import('../block-registry.service');
      const detail = await BlockRegistry.getAppDetail('ab_det', false, false);
      expect(detail).not.toBeNull();
      expect(detail?.id).toBe('ab_det');
    });

    it('default redCapable (omitted) is fail-closed → mature app is null', async () => {
      mockDbRead.$queryRaw.mockResolvedValueOnce([detailRow({ content_rating: 'r' })]);
      const { BlockRegistry } = await import('../block-registry.service');
      const detail = await BlockRegistry.getAppDetail('ab_det', false);
      expect(detail).toBeNull();
    });
  });
});
