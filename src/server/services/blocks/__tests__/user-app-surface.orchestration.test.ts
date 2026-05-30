import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Orchestration coverage for the W5 v0 reflection surface
 * (`listMyScopeGrants` + `listMyAppActivity`).
 *
 * Mocking strategy mirrors publish-request.orchestration.test.ts — vi.hoisted
 * shared mocks, vi.mock'd db client, default findMany returns [].
 */

const { mockDbRead, mockDbWrite } = vi.hoisted(() => ({
  mockDbRead: {
    modelBlockInstall: { findMany: vi.fn(), findUnique: vi.fn() },
    blockUserSubscription: { findMany: vi.fn() },
    blockBuzzAttribution: { findMany: vi.fn() },
    appBlockPublishRequest: { groupBy: vi.fn(), findFirst: vi.fn() },
    blockScopeInvocation: { findMany: vi.fn() },
  },
  mockDbWrite: {
    modelBlockInstall: { update: vi.fn() },
    blockScopeInvocation: { create: vi.fn() },
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite,
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  for (const surface of Object.values(mockDbRead)) {
    for (const fn of Object.values(surface)) {
      (fn as unknown as { mockReset: () => void }).mockReset();
    }
  }
  for (const surface of Object.values(mockDbWrite)) {
    for (const fn of Object.values(surface)) {
      (fn as unknown as { mockReset: () => void }).mockReset();
    }
  }
  mockDbRead.modelBlockInstall.findMany.mockResolvedValue([]);
  mockDbRead.blockUserSubscription.findMany.mockResolvedValue([]);
  mockDbRead.blockBuzzAttribution.findMany.mockResolvedValue([]);
  mockDbRead.appBlockPublishRequest.groupBy.mockResolvedValue([]);
  mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
  mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([]);
  mockDbWrite.modelBlockInstall.update.mockResolvedValue({});
  mockDbWrite.blockScopeInvocation.create.mockResolvedValue({});
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

// ---- W5 v0.5: listMyModelInstalls -----------------------------------------

describe('listMyModelInstalls', () => {
  function installRow(over: Record<string, unknown> = {}) {
    return {
      id: 'mbi_1',
      blockInstanceId: 'bki_1',
      modelId: 100,
      modelVersionId: 200,
      slotId: 'model.sidebar_top',
      enabled: true,
      pinnedVersion: null,
      appBlockId: 'apb_1',
      model: { id: 100, name: 'My Model' },
      appBlock: {
        id: 'apb_1',
        blockId: 'hello',
        manifest: { name: 'Hello World' },
        version: '0.2.1',
      },
      ...over,
    };
  }

  it('returns empty array when the user has no installs', async () => {
    const { listMyModelInstalls } = await import('../user-app-surface.service');
    const result = await listMyModelInstalls(42);
    expect(result).toEqual([]);
    // No need to query versions if there are no installs.
    expect(mockDbRead.appBlockPublishRequest.groupBy).not.toHaveBeenCalled();
  });

  it('batches version lookup once per distinct app', async () => {
    const { listMyModelInstalls } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findMany.mockResolvedValue([
      installRow({ id: 'mbi_1', blockInstanceId: 'bki_1', modelId: 100 }),
      installRow({ id: 'mbi_2', blockInstanceId: 'bki_2', modelId: 101 }),
      installRow({
        id: 'mbi_3',
        blockInstanceId: 'bki_3',
        modelId: 102,
        appBlockId: 'apb_2',
        appBlock: {
          id: 'apb_2',
          blockId: 'gen',
          manifest: { name: 'Gen' },
          version: '1.0.0',
        },
      }),
    ]);
    mockDbRead.appBlockPublishRequest.groupBy.mockResolvedValue([
      { appBlockId: 'apb_1', version: '0.2.1', _max: { reviewedAt: new Date('2026-05-30') } },
      { appBlockId: 'apb_2', version: '1.0.0', _max: { reviewedAt: new Date('2026-05-28') } },
    ]);
    const result = await listMyModelInstalls(42);
    expect(result).toHaveLength(3);
    expect(mockDbRead.appBlockPublishRequest.groupBy).toHaveBeenCalledTimes(1);
    const groupByArg = mockDbRead.appBlockPublishRequest.groupBy.mock.calls[0][0];
    expect(groupByArg.where.appBlockId.in).toEqual(expect.arrayContaining(['apb_1', 'apb_2']));
    expect(groupByArg.where.status).toBe('approved');
  });

  it('sorts versions newest-first within each app and denormalises onto each install', async () => {
    const { listMyModelInstalls } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findMany.mockResolvedValue([installRow()]);
    mockDbRead.appBlockPublishRequest.groupBy.mockResolvedValue([
      { appBlockId: 'apb_1', version: '0.2.0', _max: { reviewedAt: new Date('2026-05-29') } },
      { appBlockId: 'apb_1', version: '0.2.1', _max: { reviewedAt: new Date('2026-05-30') } },
      { appBlockId: 'apb_1', version: '0.1.0', _max: { reviewedAt: new Date('2026-05-27') } },
    ]);
    const [row] = await listMyModelInstalls(42);
    expect(row.availableVersions.map((v) => v.version)).toEqual(['0.2.1', '0.2.0', '0.1.0']);
    expect(row.currentVersion).toBe('0.2.1');
  });

  it('honours pinned_version on the install', async () => {
    const { listMyModelInstalls } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findMany.mockResolvedValue([
      installRow({ pinnedVersion: '0.1.0' }),
    ]);
    const [row] = await listMyModelInstalls(42);
    expect(row.pinnedVersion).toBe('0.1.0');
  });

  it('falls back to blockId when the manifest has no name', async () => {
    const { listMyModelInstalls } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findMany.mockResolvedValue([
      installRow({ appBlock: { id: 'apb_1', blockId: 'no-name', manifest: {}, version: null } }),
    ]);
    const [row] = await listMyModelInstalls(42);
    expect(row.appName).toBe('no-name');
  });
});

// ---- W5 v0.5: setInstallPinnedVersion -------------------------------------

describe('setInstallPinnedVersion', () => {
  it('rejects when the install does not exist', async () => {
    const { setInstallPinnedVersion } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue(null);
    await expect(
      setInstallPinnedVersion({ userId: 42, blockInstanceId: 'bki_missing', version: null })
    ).rejects.toThrow('install not found');
  });

  it('rejects when the caller is not the install owner', async () => {
    const { setInstallPinnedVersion } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue({
      id: 'mbi_1',
      appBlockId: 'apb_1',
      installedByUserId: 99,
    });
    await expect(
      setInstallPinnedVersion({ userId: 42, blockInstanceId: 'bki_1', version: null })
    ).rejects.toThrow('not the install owner');
  });

  it('rejects when the version is not an approved release', async () => {
    const { setInstallPinnedVersion } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue({
      id: 'mbi_1',
      appBlockId: 'apb_1',
      installedByUserId: 42,
    });
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    await expect(
      setInstallPinnedVersion({ userId: 42, blockInstanceId: 'bki_1', version: '9.9.9' })
    ).rejects.toThrow('not an approved release');
  });

  it('clears the pin when version is null without checking publish_requests', async () => {
    const { setInstallPinnedVersion } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue({
      id: 'mbi_1',
      appBlockId: 'apb_1',
      installedByUserId: 42,
    });
    await setInstallPinnedVersion({ userId: 42, blockInstanceId: 'bki_1', version: null });
    expect(mockDbRead.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
    expect(mockDbWrite.modelBlockInstall.update).toHaveBeenCalledWith({
      where: { blockInstanceId: 'bki_1' },
      data: { pinnedVersion: null },
    });
  });

  it('writes the pin when the version is approved', async () => {
    const { setInstallPinnedVersion } = await import('../user-app-surface.service');
    mockDbRead.modelBlockInstall.findUnique.mockResolvedValue({
      id: 'mbi_1',
      appBlockId: 'apb_1',
      installedByUserId: 42,
    });
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({ id: 'pubreq_1' });
    const result = await setInstallPinnedVersion({
      userId: 42,
      blockInstanceId: 'bki_1',
      version: '0.2.1',
    });
    expect(result).toEqual({ ok: true });
    expect(mockDbWrite.modelBlockInstall.update).toHaveBeenCalledWith({
      where: { blockInstanceId: 'bki_1' },
      data: { pinnedVersion: '0.2.1' },
    });
  });
});

// ---- W5 v0.5: listMyScopeInvocations --------------------------------------

describe('listMyScopeInvocations', () => {
  function invocationRow(over: Record<string, unknown> = {}) {
    return {
      id: 100n,
      invokedAt: new Date('2026-05-30T12:00:00Z'),
      appBlockId: 'apb_1',
      blockInstanceId: 'bki_1',
      scope: 'user:read:self',
      endpoint: '/api/v1/blocks/me',
      statusCode: 200,
      appBlock: { blockId: 'who-am-i', manifest: { name: 'Who Am I' } },
      ...over,
    };
  }

  it('returns empty page when there are no invocations', async () => {
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    const result = await listMyScopeInvocations({ userId: 42 });
    expect(result).toEqual({ items: [], nextCursor: null });
  });

  it('serialises BigInt id to string for JSON safety', async () => {
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue([invocationRow({ id: 12345n })]);
    const result = await listMyScopeInvocations({ userId: 42 });
    expect(result.items[0].id).toBe('12345');
  });

  it('caps limit at 100 even when caller asks for more', async () => {
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    await listMyScopeInvocations({ userId: 42, limit: 9999 });
    const arg = mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0];
    expect(arg.take).toBe(101);
  });

  it('passes appBlockId filter through to the query', async () => {
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    await listMyScopeInvocations({ userId: 42, appBlockId: 'apb_target' });
    const arg = mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ userId: 42, appBlockId: 'apb_target' });
  });

  it('emits a nextCursor when the page is full and silently ignores a malformed inbound cursor', async () => {
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    // 1 more row than limit → hasNext + nextCursor is the last visible id.
    const rows = Array.from({ length: 3 }, (_, i) =>
      invocationRow({ id: BigInt(100 - i) })
    );
    mockDbRead.blockScopeInvocation.findMany.mockResolvedValue(rows);
    const result = await listMyScopeInvocations({
      userId: 42,
      limit: 2,
      cursor: 'not-a-bigint',
    });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe('99'); // last visible row's id
    // Defensive cursor handling: bad cursor is treated as "no cursor", not an error.
    const arg = mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0];
    expect(arg.cursor).toBeUndefined();
  });

  it('uses BigInt cursor when caller provides a valid numeric string', async () => {
    const { listMyScopeInvocations } = await import('../user-app-surface.service');
    await listMyScopeInvocations({ userId: 42, cursor: '12345' });
    const arg = mockDbRead.blockScopeInvocation.findMany.mock.calls[0][0];
    expect(arg.cursor).toEqual({ id: 12345n });
    expect(arg.skip).toBe(1);
  });
});

// ---- W5 v0.5: recordScopeInvocation ---------------------------------------

describe('recordScopeInvocation', () => {
  it('inserts a row with the expected shape', async () => {
    const { recordScopeInvocation } = await import('../user-app-surface.service');
    await recordScopeInvocation({
      userId: 42,
      appBlockId: 'apb_1',
      blockInstanceId: 'bki_1',
      scope: 'user:read:self',
      endpoint: '/api/v1/blocks/me',
      statusCode: 200,
    });
    expect(mockDbWrite.blockScopeInvocation.create).toHaveBeenCalledWith({
      data: {
        userId: 42,
        appBlockId: 'apb_1',
        blockInstanceId: 'bki_1',
        scope: 'user:read:self',
        endpoint: '/api/v1/blocks/me',
        statusCode: 200,
      },
    });
  });

  it('clamps a runaway endpoint string to 512 chars', async () => {
    const { recordScopeInvocation } = await import('../user-app-surface.service');
    const huge = '/x/'.repeat(1000);
    await recordScopeInvocation({
      userId: 42,
      appBlockId: 'apb_1',
      blockInstanceId: 'bki_1',
      scope: 's',
      endpoint: huge,
      statusCode: 200,
    });
    const arg = mockDbWrite.blockScopeInvocation.create.mock.calls[0][0];
    expect(arg.data.endpoint.length).toBe(512);
  });

  it('swallows db errors so the request lifecycle is not affected', async () => {
    const { recordScopeInvocation } = await import('../user-app-surface.service');
    mockDbWrite.blockScopeInvocation.create.mockRejectedValueOnce(new Error('FK violation'));
    // Must not throw — caller is `res.on('finish')` and has no error handler.
    await expect(
      recordScopeInvocation({
        userId: 42,
        appBlockId: 'apb_deleted',
        blockInstanceId: 'bki_1',
        scope: 's',
        endpoint: '/x',
        statusCode: 200,
      })
    ).resolves.toBeUndefined();
  });
});
