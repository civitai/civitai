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
  const pubreq = () => ({ findFirst: vi.fn(async (): Promise<unknown> => null) });
  return {
    mockDbRead: {
      $queryRaw: vi.fn(async () => []),
      appBlock: ab(),
      appBlockPublishRequest: pubreq(),
    },
    mockDbWrite: { appBlock: ab(), appBlockPublishRequest: pubreq() },
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

  // ── EPHEMERAL PRE-SUBMIT FALLBACK (Phase 1) ──────────────────────────────

  it('(a) resolves an EPHEMERAL synthetic for an UNCLAIMED slug the caller owns no row for', async () => {
    // No owned AppBlock row (owned findFirst → null), no foreign AppBlock row
    // (findUnique → null), no pending request (pubreq findFirst → null).
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    const res = await BlockRegistry.resolveDevPageBlockForAuthor('brand-new', 555);
    expect(res).not.toBeNull();
    expect(res?.status).toBe('ephemeral');
    expect(res?.trustTier).toBe('unverified');
    expect(res?.scopes).toEqual([]); // scoped mint stays 403 until approval
    expect(res?.contentRating).toBeNull(); // SFW default
    expect(res?.sandbox).toBe('allow-scripts allow-forms');
    expect(res?.blockId).toBe('brand-new');
    // Synthetic, non-resolving ids — never an `appblk-`/UUID that could FK-resolve.
    expect(res?.appBlockId).toBe('ephemeral-brand-new');
    expect(res?.appId).toBe('ephemeral-brand-new');
    // No iframeSrc — the route derives the host from the tunnel only.
    expect((res as Record<string, unknown>).iframeSrc).toBeUndefined();
    // Anti-shadow guard queries: indexed unique lookup + pending lookup on the slug.
    expect(mockDbRead.appBlock.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { blockId: 'brand-new' } })
    );
    expect(mockDbRead.appBlockPublishRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'brand-new', status: 'pending' } })
    );
  });

  it('(b) REFUSES (→ null, no oracle) a slug with a FOREIGN AppBlock row (approved, other owner)', async () => {
    // The owned findFirst returns null (not the caller's), but a row EXISTS for
    // the slug globally (@@unique) — so it belongs to someone else. Bare null.
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_someone_else' });
    expect(await BlockRegistry.resolveDevPageBlockForAuthor('their-app', 555)).toBeNull();
    // Refused at guard (A) — never even reaches the pending lookup.
    expect(mockDbRead.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
  });

  it('(c) REFUSES (→ null, no oracle) a slug with a FOREIGN pending publish request', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({ submittedByUserId: 999 });
    expect(await BlockRegistry.resolveDevPageBlockForAuthor('someone-pending', 555)).toBeNull();
  });

  it('(d) ALLOWS an ephemeral resolution when the caller OWNS the pending publish request', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({ submittedByUserId: 555 });
    const res = await BlockRegistry.resolveDevPageBlockForAuthor('my-pending', 555);
    expect(res).not.toBeNull();
    expect(res?.status).toBe('ephemeral');
    expect(res?.blockId).toBe('my-pending');
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
