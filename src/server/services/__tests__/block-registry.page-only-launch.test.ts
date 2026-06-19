import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PAGE-ONLY LAUNCH GATE — service-level tests for the public marketplace reads
 * (`BlockRegistry.listAvailable` / `getFeaturedBlocks` / `getAppDetail`).
 *
 * The public (non-moderator) audience sees launch (page) apps ONLY; moderators
 * are grandfathered (see everything). The router passes `launchOnly =
 * !ctx.user?.isModerator`. These tests pin:
 *   - listAvailable / getFeaturedBlocks thread the page-app SQL filter into the
 *     query iff launchOnly (and omit it for mods);
 *   - getAppDetail returns null for a non-launch (model) app under launchOnly
 *     (→ router NOT_FOUND), returns a page app under launchOnly, and returns a
 *     model app when launchOnly=false (mod / grandfather).
 *
 * Mocks @prisma/client so `Prisma.sql` works without a generated client (the
 * local NixOS Prisma stub has no `sql`), and stubs dbRead.$queryRaw to capture
 * the assembled SQL + return seeded rows.
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    blockUserSubscription: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    appBlock: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    modelVersion: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) },
  },
}));

// A minimal Prisma.sql shim that records its template so the assembled SQL is
// reconstructable. Each Prisma.sql(...) call returns a tagged object carrying a
// `.sql` string; interpolating one inside another flattens via toString.
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
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));

/** Reconstruct the assembled SQL string from the captured Prisma.sql object. */
function capturedSql(): string {
  expect(mockDbRead.$queryRaw).toHaveBeenCalled();
  const lastCall = mockDbRead.$queryRaw.mock.calls.at(-1);
  if (!lastCall) return '';
  const first = lastCall[0] as unknown;
  if (first && typeof first === 'object' && typeof (first as { sql?: unknown }).sql === 'string') {
    return (first as { sql: string }).sql;
  }
  // Tagged-template form (getFeaturedBlocks): rebuild from strings + values.
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

const PAGE_FILTER_RE = /ab\.manifest->'page'->>'path'/;

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
    manifest: { name: 'Cool Block', targets: [{ slotId: 'model.sidebar_top' }] },
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
    content_rating: null,
    version: '1.0.0',
    approved_scopes: ['user:read:self'],
    install_count: 3n,
    screenshots: null,
    // model app by default (no page field)
    manifest: { name: 'Detail Block', targets: [{ slotId: 'model.sidebar_top' }] },
    ...over,
  };
}

describe('BlockRegistry — page-only launch gate (public reads)', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([listRow()]);
  });

  describe('listAvailable', () => {
    it('non-mod (launchOnly=true) threads the page-app filter into the SQL', async () => {
      const { BlockRegistry } = await import('../block-registry.service');
      await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' }, true);
      expect(capturedSql()).toMatch(PAGE_FILTER_RE);
    });

    it('mod (launchOnly=false / default) does NOT add the page-app filter', async () => {
      const { BlockRegistry } = await import('../block-registry.service');
      await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' }, false);
      expect(capturedSql()).not.toMatch(PAGE_FILTER_RE);
      // default param is also non-launch (mods/internal callers)
      mockDbRead.$queryRaw.mockClear();
      await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' });
      expect(capturedSql()).not.toMatch(PAGE_FILTER_RE);
    });

    it('the approved-only filter still stands under launchOnly (no regression)', async () => {
      const { BlockRegistry } = await import('../block-registry.service');
      await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' }, true);
      expect(capturedSql()).toMatch(/ab\.status\s*=\s*'approved'/);
    });
  });

  describe('getFeaturedBlocks', () => {
    it('non-mod (launchOnly=true) threads the page-app filter into the SQL', async () => {
      const { BlockRegistry } = await import('../block-registry.service');
      await BlockRegistry.getFeaturedBlocks(12, true);
      expect(capturedSql()).toMatch(PAGE_FILTER_RE);
    });

    it('mod (launchOnly=false / default) does NOT add the page-app filter', async () => {
      const { BlockRegistry } = await import('../block-registry.service');
      await BlockRegistry.getFeaturedBlocks(12, false);
      expect(capturedSql()).not.toMatch(PAGE_FILTER_RE);
    });
  });

  describe('getAppDetail', () => {
    it('non-mod (launchOnly=true): a MODEL app resolves to null (→ NOT_FOUND, no leak)', async () => {
      mockDbRead.$queryRaw.mockResolvedValueOnce([detailRow()]); // model app
      const { BlockRegistry } = await import('../block-registry.service');
      const detail = await BlockRegistry.getAppDetail('ab_det', true);
      expect(detail).toBeNull();
    });

    it('non-mod (launchOnly=true): a PAGE app resolves normally', async () => {
      mockDbRead.$queryRaw.mockResolvedValueOnce([
        detailRow({ manifest: { name: 'Page Block', page: { path: '/run', title: 'Run' } } }),
      ]);
      const { BlockRegistry } = await import('../block-registry.service');
      const detail = await BlockRegistry.getAppDetail('ab_det', true);
      expect(detail).not.toBeNull();
      expect(detail?.id).toBe('ab_det');
    });

    it('mod (launchOnly=false / default): a MODEL app resolves normally (grandfather)', async () => {
      mockDbRead.$queryRaw.mockResolvedValueOnce([detailRow()]); // model app
      const { BlockRegistry } = await import('../block-registry.service');
      const detail = await BlockRegistry.getAppDetail('ab_det', false);
      expect(detail).not.toBeNull();
      expect(detail?.id).toBe('ab_det');
      // default param behaves like a mod (back-compat for internal callers)
      mockDbRead.$queryRaw.mockResolvedValueOnce([detailRow()]);
      const detail2 = await BlockRegistry.getAppDetail('ab_det');
      expect(detail2).not.toBeNull();
    });

    it('a non-approved app is null regardless of launchOnly (approved-gate unchanged)', async () => {
      mockDbRead.$queryRaw.mockResolvedValueOnce([
        detailRow({ status: 'pending', manifest: { name: 'P', page: { path: '/x', title: 'X' } } }),
      ]);
      const { BlockRegistry } = await import('../block-registry.service');
      expect(await BlockRegistry.getAppDetail('ab_det', true)).toBeNull();
    });
  });
});
