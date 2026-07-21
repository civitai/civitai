import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * APP DEV TUNNEL — BlockRegistry.resolveOwnedNonApprovedPageBlock.
 *
 * The DEV-TUNNEL-ONLY companion to resolvePageBlock. It resolves the caller's OWN
 * page app when it is NOT approved (suspended / pending re-submitted / deprecated)
 * so the owner can dogfood it in their own tunnel, while the PUBLIC run path stays
 * approved-only. Pins:
 *   - the query is OWNERSHIP-scoped (app.userId === caller) AND non-approved-only
 *     (status != approved) — a foreign / missing / approved row → null (no oracle),
 *   - scopes are sourced from the APPROVED SNAPSHOT column (approvedScopes),
 *   - a non-page manifest → null,
 *   - the manifest is surfaced (for the caller's page.buzzBudgetPerGen read).
 */

const { mockDbRead, mockDbWrite, mockRedis, mockSysRedis } = vi.hoisted(() => {
  const dbRead = {
    appBlock: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
  };
  const dbWrite = {
    appBlock: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
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
    BLOCKS: { REGISTRY: 'r', TOKEN_RATE_LIMIT: 'rl', REVOKED_INSTANCE: 'rev' },
  },
  REDIS_SYS_KEYS: { BLOCKS: { EMERGENCY_KILL_LIST: 'kill' } },
}));

import { BlockRegistry } from '~/server/services/block-registry.service';

const PAGE_MANIFEST = (overrides: Record<string, unknown> = {}) => ({
  name: 'My App',
  page: { path: '/', title: 'My App', buzzBudgetPerGen: 75 },
  iframe: { src: 'https://my-app.civit.ai', sandbox: 'allow-scripts allow-forms' },
  scopes: ['ai:write:budgeted', 'user:read:self'],
  ...overrides,
});

/** A NON-approved AppBlock row as the resolveOwnedNonApprovedPageBlock select returns it. */
function ownedRow(opts: {
  status: string;
  manifest?: Record<string, unknown>;
  approvedScopes?: string[];
}) {
  return {
    id: 'apb_real',
    blockId: 'my-app',
    appId: 'appblk-my-app',
    status: opts.status,
    manifest: opts.manifest ?? PAGE_MANIFEST(),
    approvedScopes: opts.approvedScopes ?? ['ai:write:budgeted', 'user:read:self'],
  };
}

describe('BlockRegistry.resolveOwnedNonApprovedPageBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves an OWNED suspended page app, surfacing the approved snapshot + manifest', async () => {
    mockDbWrite.appBlock.findFirst.mockResolvedValue(ownedRow({ status: 'suspended' }));
    const res = await BlockRegistry.resolveOwnedNonApprovedPageBlock('apb_real', 42, {
      db: 'write',
    });
    expect(res).not.toBeNull();
    expect(res?.appBlockId).toBe('apb_real');
    expect(res?.blockId).toBe('my-app');
    expect(res?.appId).toBe('appblk-my-app');
    expect(res?.status).toBe('suspended');
    // Scope source is the approved-snapshot COLUMN, not the raw manifest.
    expect(res?.approvedScopes).toEqual(['ai:write:budgeted', 'user:read:self']);
    // The manifest is surfaced so the caller can read page.buzzBudgetPerGen.
    expect((res?.manifest.page as { buzzBudgetPerGen?: number })?.buzzBudgetPerGen).toBe(75);
  });

  it.each([['pending'], ['deprecated'], ['rejected']])(
    'resolves an owned non-approved app in status %s',
    async (status) => {
      mockDbWrite.appBlock.findFirst.mockResolvedValue(ownedRow({ status }));
      const res = await BlockRegistry.resolveOwnedNonApprovedPageBlock('apb_real', 42, {
        db: 'write',
      });
      expect(res?.status).toBe(status);
    }
  );

  it('scopes the query to OWNERSHIP (app.userId) AND non-approved (status != approved)', async () => {
    mockDbWrite.appBlock.findFirst.mockResolvedValue(ownedRow({ status: 'suspended' }));
    await BlockRegistry.resolveOwnedNonApprovedPageBlock('apb_real', 42, { db: 'write' });
    const call = mockDbWrite.appBlock.findFirst.mock.calls.at(-1)?.[0] as {
      where?: Record<string, unknown>;
      select?: Record<string, unknown>;
    };
    expect(call?.where).toEqual({
      id: 'apb_real',
      app: { userId: 42 },
      status: { not: 'approved' },
    });
    // The approved-snapshot column is actually read.
    expect(call?.select?.approvedScopes).toBe(true);
  });

  it('returns null when the query finds no owned non-approved row (foreign / missing / approved)', async () => {
    // A foreign-owned, missing, OR approved app all fall out of the ownership+status
    // query as null — the caller renders the SAME bare 404 (no oracle).
    mockDbWrite.appBlock.findFirst.mockResolvedValue(null);
    const res = await BlockRegistry.resolveOwnedNonApprovedPageBlock('apb_real', 42, {
      db: 'write',
    });
    expect(res).toBeNull();
  });

  it('returns null for a non-page manifest (no page descriptor)', async () => {
    mockDbWrite.appBlock.findFirst.mockResolvedValue(
      ownedRow({
        status: 'suspended',
        manifest: { name: 'x', iframe: { src: 'https://x.civit.ai' } },
      })
    );
    const res = await BlockRegistry.resolveOwnedNonApprovedPageBlock('apb_real', 42, {
      db: 'write',
    });
    expect(res).toBeNull();
  });

  it('returns null on empty inputs (no appBlockId / no userId) without a DB read', async () => {
    expect(await BlockRegistry.resolveOwnedNonApprovedPageBlock('', 42)).toBeNull();
    expect(await BlockRegistry.resolveOwnedNonApprovedPageBlock('apb_real', 0)).toBeNull();
    expect(mockDbWrite.appBlock.findFirst).not.toHaveBeenCalled();
    expect(mockDbRead.appBlock.findFirst).not.toHaveBeenCalled();
  });

  it('surfaces an EMPTY approved snapshot as [] (caller mints a read-only token)', async () => {
    mockDbWrite.appBlock.findFirst.mockResolvedValue(
      ownedRow({ status: 'suspended', approvedScopes: [] })
    );
    const res = await BlockRegistry.resolveOwnedNonApprovedPageBlock('apb_real', 42, {
      db: 'write',
    });
    expect(res?.approvedScopes).toEqual([]);
  });
});
