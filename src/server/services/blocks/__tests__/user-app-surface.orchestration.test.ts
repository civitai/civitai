import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Orchestration coverage for the W5 v0 reflection surface
 * (`listMyScopeGrants` + `listMyAppActivity`).
 *
 * Mocking strategy mirrors publish-request.orchestration.test.ts — vi.hoisted
 * shared mocks, vi.mock'd db client, default findMany returns [].
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    modelBlockInstall: { findMany: vi.fn() },
    blockUserSubscription: { findMany: vi.fn() },
    blockBuzzAttribution: { findMany: vi.fn() },
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: {},
}));

beforeEach(() => {
  for (const surface of Object.values(mockDbRead)) {
    for (const fn of Object.values(surface)) {
      (fn as unknown as { mockReset: () => void }).mockReset();
    }
  }
  mockDbRead.modelBlockInstall.findMany.mockResolvedValue([]);
  mockDbRead.blockUserSubscription.findMany.mockResolvedValue([]);
  mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([]);
});

// ---- listMyScopeGrants -----------------------------------------------------

describe('listMyScopeGrants', () => {
  function appBlock(over: Record<string, unknown> = {}) {
    return {
      id: 'apb_1',
      blockId: 'hello',
      manifest: { name: 'Hello World', scopes: ['user:read:self'] },
      approvedScopes: ['user:read:self'],
      ...over,
    };
  }

  it('returns empty array when the user has no installs and no subscriptions', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    const result = await listMyScopeGrants(42);
    expect(result).toEqual([]);
  });

  it('aggregates 2 installs + 1 subscription for the same app into a single row', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findMany.mockResolvedValue([
      { appBlockId: 'apb_1', appBlock: appBlock() },
      { appBlockId: 'apb_1', appBlock: appBlock() },
    ]);
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      { appBlockId: 'apb_1', scope: 'viewer_personal', appBlock: appBlock() },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result).toHaveLength(1);
    expect(result[0].appBlockId).toBe('apb_1');
    expect(result[0].surfaces.modelInstallCount).toBe(2);
    expect(result[0].surfaces.subscriptionScopes).toEqual(['viewer_personal']);
  });

  it('skips disabled model installs at the where layer', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findMany.mockResolvedValue([]);
    await listMyScopeGrants(42);
    expect(mockDbRead.modelBlockInstall.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { installedByUserId: 42, enabled: true },
      })
    );
  });

  it('reads scopes from the joined manifest.scopes', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_1',
        appBlock: appBlock({
          manifest: { name: 'Hello', scopes: ['ai:write:budgeted', 'buzz:read:self'] },
        }),
      },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].scopes).toEqual(['ai:write:budgeted', 'buzz:read:self']);
  });

  it('falls back to approvedScopes when manifest.scopes is missing', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_1',
        appBlock: appBlock({
          manifest: { name: 'Hello' }, // no scopes
          approvedScopes: ['models:read:self'],
        }),
      },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].scopes).toEqual(['models:read:self']);
  });

  it('emits an empty scopes array when neither manifest nor approvedScopes carry scopes', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_1',
        appBlock: appBlock({
          manifest: { name: 'Hello' },
          approvedScopes: [],
        }),
      },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].scopes).toEqual([]);
  });

  it('sorts rows by app name ascending', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_z',
        scope: 'viewer_personal',
        appBlock: appBlock({ id: 'apb_z', blockId: 'z', manifest: { name: 'Zeta' } }),
      },
      {
        appBlockId: 'apb_a',
        scope: 'viewer_personal',
        appBlock: appBlock({ id: 'apb_a', blockId: 'a', manifest: { name: 'Alpha' } }),
      },
      {
        appBlockId: 'apb_m',
        scope: 'viewer_personal',
        appBlock: appBlock({ id: 'apb_m', blockId: 'm', manifest: { name: 'Mu' } }),
      },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result.map((r) => r.name)).toEqual(['Alpha', 'Mu', 'Zeta']);
  });

  it('falls back to slug for name when manifest.name is missing', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_1',
        appBlock: appBlock({ blockId: 'hello-world', manifest: { scopes: [] } }),
      },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].name).toBe('hello-world');
  });

  it('captures both subscription scopes when an app is subscribed under both', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.blockUserSubscription.findMany.mockResolvedValue([
      { appBlockId: 'apb_1', scope: 'publisher_all_my_models', appBlock: appBlock() },
      { appBlockId: 'apb_1', scope: 'viewer_personal', appBlock: appBlock() },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].surfaces.subscriptionScopes).toEqual([
      'publisher_all_my_models',
      'viewer_personal',
    ]);
    // modelInstallCount=0 when there are no model installs.
    expect(result[0].surfaces.modelInstallCount).toBe(0);
  });

  it('surfaces iconUrl when manifest carries one', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_1',
        appBlock: appBlock({
          manifest: { name: 'Hello', iconUrl: 'https://cdn.example/icon.png' },
        }),
      },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].iconUrl).toBe('https://cdn.example/icon.png');
  });

  it('omits iconUrl when manifest does not declare one', async () => {
    const { listMyScopeGrants } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findMany.mockResolvedValue([
      {
        appBlockId: 'apb_1',
        appBlock: appBlock(),
      },
    ]);
    const result = await listMyScopeGrants(42);
    expect(result[0].iconUrl).toBeUndefined();
  });
});

// ---- listMyAppActivity -----------------------------------------------------

describe('listMyAppActivity', () => {
  function row(over: Record<string, unknown> = {}) {
    return {
      id: 'bba_1',
      attributedAt: new Date('2026-05-28T10:00:00Z'),
      appBlockId: 'apb_1',
      blockInstanceId: 'bki_1',
      scope: 'per_model_install',
      usdAmountCents: 199,
      status: 'pending',
      appBlock: { blockId: 'hello', manifest: { name: 'Hello World' } },
      ...over,
    };
  }

  it('returns empty page when there are no rows', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    const result = await listMyAppActivity({ userId: 42 });
    expect(result).toEqual({ items: [], nextCursor: null });
  });

  it('filters by the spender userId', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    await listMyAppActivity({ userId: 42 });
    expect(mockDbRead.blockBuzzAttribution.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 42 } })
    );
  });

  it('joins the AppBlock and exposes appName + appSlug per item', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([
      row({ appBlock: { blockId: 'gen-from-model', manifest: { name: 'Generate' } } }),
    ]);
    const result = await listMyAppActivity({ userId: 42 });
    expect(result.items[0].appName).toBe('Generate');
    expect(result.items[0].appSlug).toBe('gen-from-model');
  });

  it('falls back to blockId when manifest.name missing', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([
      row({ appBlock: { blockId: 'gen-from-model', manifest: {} } }),
    ]);
    const result = await listMyAppActivity({ userId: 42 });
    expect(result.items[0].appName).toBe('gen-from-model');
  });

  it('falls back to appBlockId when appBlock relation is null (defensive)', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([
      row({ appBlock: null, appBlockId: 'apb_x' }),
    ]);
    const result = await listMyAppActivity({ userId: 42 });
    expect(result.items[0].appName).toBe('apb_x');
    expect(result.items[0].appSlug).toBe('apb_x');
  });

  it('orderBy is createdAt desc + id desc tiebreak', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    await listMyAppActivity({ userId: 42 });
    const arg = mockDbRead.blockBuzzAttribution.findMany.mock.calls[0][0];
    expect(arg.orderBy).toEqual([{ attributedAt: 'desc' }, { id: 'desc' }]);
  });

  it('fetches limit + 1 to detect next page', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    await listMyAppActivity({ userId: 42, limit: 10 });
    const arg = mockDbRead.blockBuzzAttribution.findMany.mock.calls[0][0];
    expect(arg.take).toBe(11);
  });

  it('drops the trailing row when limit + 1 are returned and surfaces nextCursor', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([
      row({ id: 'bba_1' }),
      row({ id: 'bba_2' }),
      row({ id: 'bba_3' }), // the trailing has-next indicator
    ]);
    const result = await listMyAppActivity({ userId: 42, limit: 2 });
    expect(result.items.map((i) => i.id)).toEqual(['bba_1', 'bba_2']);
    expect(result.nextCursor).toBe('bba_2');
  });

  it('returns nextCursor=null when fewer than limit + 1 rows come back', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([row({ id: 'bba_1' })]);
    const result = await listMyAppActivity({ userId: 42, limit: 10 });
    expect(result.items.map((i) => i.id)).toEqual(['bba_1']);
    expect(result.nextCursor).toBeNull();
  });

  it('cursor + skip:1 are forwarded to Prisma when caller supplies a cursor', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    await listMyAppActivity({ userId: 42, limit: 5, cursor: 'bba_99' });
    const arg = mockDbRead.blockBuzzAttribution.findMany.mock.calls[0][0];
    expect(arg.cursor).toEqual({ id: 'bba_99' });
    expect(arg.skip).toBe(1);
    expect(arg.take).toBe(6);
  });

  it('caps limit at 100 even when caller asks for more', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    await listMyAppActivity({ userId: 42, limit: 5000 });
    const arg = mockDbRead.blockBuzzAttribution.findMany.mock.calls[0][0];
    expect(arg.take).toBe(101); // 100 cap + 1
  });

  it('defaults limit to 25 when not supplied', async () => {
    const { listMyAppActivity } = await import('../user-app-surface.service');
    await listMyAppActivity({ userId: 42 });
    const arg = mockDbRead.blockBuzzAttribution.findMany.mock.calls[0][0];
    expect(arg.take).toBe(26);
  });
});
