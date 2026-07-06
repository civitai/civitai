import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APP DEV TUNNEL — BlockRegistry.resolveDevPageBlockForAuthor.
 *
 * The dev route resolver: resolves the caller's OWN app by blockId at ANY status,
 * ownership-scoped. Foreign / absent → null (no oracle). Pins the two invariants
 * that keep the dev path disjoint from the public run path:
 *   - it never requires status:approved (a draft/pending own app resolves), and
 *   - it carries NO iframeSrc (the route derives the host from the tunnel only).
 */

const { mockDbRead, mockDbWrite, mockRedis, mockSysRedis } = vi.hoisted(() => {
  const ab = () => ({
    findUnique: vi.fn(async (): Promise<unknown> => null),
    findFirst: vi.fn(async (): Promise<unknown> => null),
  });
  return {
    mockDbRead: { $queryRaw: vi.fn(async () => []), appBlock: ab() },
    mockDbWrite: { appBlock: ab() },
    mockRedis: {
      packed: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      del: vi.fn(async () => 0),
      scanIterator: async function* () {},
    },
    mockSysRedis: { sMembers: vi.fn(async () => []) },
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  sysRedis: mockSysRedis,
  REDIS_KEYS: { BLOCKS: { REGISTRY: 'r', TOKEN_RATE_LIMIT: 'rl', REVOKED_INSTANCE: 'rev' } },
  REDIS_SYS_KEYS: { BLOCKS: { EMERGENCY_KILL_LIST: 'kill' } },
}));

import { BlockRegistry } from '~/server/services/block-registry.service';

function ownRow(status: string) {
  return {
    id: 'apb_dev',
    blockId: 'my-app',
    appId: 'appblk-my-app',
    status,
    manifest: { name: 'My App', scopes: ['ai:write:budgeted'], iframe: { sandbox: 'allow-scripts' } },
    trustTier: 'unverified',
    contentRating: null,
  };
}

describe('BlockRegistry.resolveDevPageBlockForAuthor', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['draft', 'pending', 'approved', 'rejected'])(
    'resolves the caller’s OWN app at status=%s (status-agnostic)',
    async (status) => {
      mockDbRead.appBlock.findFirst.mockResolvedValue(ownRow(status));
      const res = await BlockRegistry.resolveDevPageBlockForAuthor('my-app', 555);
      expect(res).not.toBeNull();
      expect(res?.status).toBe(status);
      expect(res?.appBlockId).toBe('apb_dev');
      expect(res?.scopes).toEqual(['ai:write:budgeted']);
      // The query is OWNERSHIP-scoped: blockId + app.userId.
      expect(mockDbRead.appBlock.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { blockId: 'my-app', app: { userId: 555 } } })
      );
      // NO iframeSrc field exists on the dev resolution — it can never serve a
      // deployed <slug>.civit.ai bundle.
      expect((res as Record<string, unknown>).iframeSrc).toBeUndefined();
    }
  );

  it('returns null for another author’s app (foreign/absent → the same null, no oracle)', async () => {
    // The ownership predicate is in the WHERE, so a foreign app simply doesn't match.
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    expect(await BlockRegistry.resolveDevPageBlockForAuthor('their-app', 555)).toBeNull();
  });

  it('returns null on empty inputs (fail-closed)', async () => {
    expect(await BlockRegistry.resolveDevPageBlockForAuthor('', 555)).toBeNull();
    expect(await BlockRegistry.resolveDevPageBlockForAuthor('my-app', 0)).toBeNull();
    expect(mockDbRead.appBlock.findFirst).not.toHaveBeenCalled();
  });

  it('INVARIANT: the public resolvePageBlockBySlug requires status:approved (never a dev/draft app)', async () => {
    // The public run path only ever resolves an APPROVED app (its WHERE pins
    // status:'approved') — so a draft/pending dev app is invisible to it, keeping
    // the two paths disjoint. A non-approved row → the findFirst below returns null.
    mockDbRead.appBlock.findFirst.mockResolvedValue(null); // no approved row for a draft slug
    expect(await BlockRegistry.resolvePageBlockBySlug('my-app', { db: 'read' })).toBeNull();
    expect(mockDbRead.appBlock.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { blockId: 'my-app', status: 'approved' } })
    );
  });
});
