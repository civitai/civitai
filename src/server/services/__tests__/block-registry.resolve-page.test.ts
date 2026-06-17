import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * W10 — BlockRegistry.resolvePageBlockBySlug (the SSR page resolver).
 *
 * Pins the security-critical sourcing of the iframe sandbox's TRUST TIER:
 * it MUST come from the authoritative, mod-controlled `AppBlock.trustTier`
 * COLUMN — NOT `manifest.trustTier`, which is a publisher-self-declared field.
 * Sourcing the tier from the manifest reintroduces the C1 trust-tier
 * self-escalation class for the page sandbox (a publisher could declare
 * `internal` to widen its own sandbox). Mirrors the model render path, which
 * treats the column as authoritative (resolveRenderMode reads the column).
 *
 * Also covers the #7 nit (sandbox extracted independently of `iframe.src`'s
 * type) and the #3/#6 scope surfacing (declared scopes returned for the host's
 * granted-scope computation).
 */

const { mockDbRead, mockDbWrite, mockRedis, mockSysRedis } = vi.hoisted(() => {
  const dbRead = {
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
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

/** A valid approved page AppBlock row as Prisma would return it from the
 *  resolvePageBlockBySlug select (id/blockId/appId/manifest/trustTier). */
function pageRow(opts: {
  manifest: Record<string, unknown>;
  trustTier: string;
}) {
  return {
    id: 'apb_page',
    blockId: 'hello-page',
    appId: 'appblk-hello-page',
    manifest: opts.manifest,
    trustTier: opts.trustTier,
  };
}

const PAGE_MANIFEST = (overrides: Record<string, unknown> = {}) => ({
  name: 'Hello Page',
  page: { path: '/', title: 'Hello' },
  iframe: { src: 'https://hello-page.civit.ai', sandbox: 'allow-scripts allow-forms' },
  ...overrides,
});

describe('BlockRegistry.resolvePageBlockBySlug — trust tier sourcing (#2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the authoritative trustTier COLUMN, not manifest.trustTier (column=unverified wins over manifest=internal → restrictive sandbox)', async () => {
    // The publisher SELF-DECLARES `internal` in the manifest (the widest tier),
    // but the mod-controlled COLUMN says `unverified`. The column MUST win.
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({
        manifest: PAGE_MANIFEST({ trustTier: 'internal' }),
        trustTier: 'unverified',
      })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res).not.toBeNull();
    // The COLUMN value wins — a self-declared `internal` manifest does NOT
    // escalate the page sandbox's trust tier.
    expect(res?.trustTier).toBe('unverified');
  });

  it('honours a column value of internal even when manifest declares unverified', async () => {
    // The inverse: a mod has GRANTED `internal` in the column; a stale/cautious
    // manifest says `unverified`. The column is still authoritative.
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({
        manifest: PAGE_MANIFEST({ trustTier: 'unverified' }),
        trustTier: 'internal',
      })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res?.trustTier).toBe('internal');
  });

  it('maps an unknown/garbage column value to unverified (fail-closed)', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({ manifest: PAGE_MANIFEST(), trustTier: 'totally-bogus' })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res?.trustTier).toBe('unverified');
  });

  it('the select requests the trustTier column (so the column is actually read)', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({ manifest: PAGE_MANIFEST(), trustTier: 'verified' })
    );
    await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    const call = mockDbRead.appBlock.findFirst.mock.calls.at(-1)?.[0] as {
      select?: Record<string, unknown>;
    };
    expect(call?.select?.trustTier).toBe(true);
  });
});

describe('BlockRegistry.resolvePageBlockBySlug — sandbox + scopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('#7: extracts the sandbox independently of iframe.src being a string', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({ manifest: PAGE_MANIFEST(), trustTier: 'verified' })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res?.sandbox).toBe('allow-scripts allow-forms');
    expect(res?.iframeSrc).toBe('https://hello-page.civit.ai');
  });

  it('#3/#6: surfaces the page manifest declared scopes for the host', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({
        manifest: PAGE_MANIFEST({ scopes: ['apps:storage:read', 'apps:storage:write', 42] }),
        trustTier: 'verified',
      })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    // Non-string entries are filtered out.
    expect(res?.scopes).toEqual(['apps:storage:read', 'apps:storage:write']);
  });

  it('returns scopes:[] when the manifest declares none', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({ manifest: PAGE_MANIFEST(), trustTier: 'verified' })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res?.scopes).toEqual([]);
  });

  it('returns null for a non-page manifest (no page descriptor)', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({ manifest: { name: 'x', iframe: { src: 'https://x.civit.ai' } }, trustTier: 'verified' })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res).toBeNull();
  });

  it('returns null when no approved row owns the slug', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    const res = await BlockRegistry.resolvePageBlockBySlug('missing', { db: 'read' });
    expect(res).toBeNull();
  });
});
