import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Coverage for `apps.storage.{get,set,delete,list,getQuota}`. Mocks the
 * pg pool + the block-token verifier so the router runs in-process and
 * we can pin each auth/quota gate independently.
 */

const {
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockDbRead,
  mockIsAppBlocksEnabled,
  mockPool,
  mockClient,
  mockGetQuota,
  mockProvisionReviewPreview,
  mockLogToAxiom,
  mockGetUserById,
  mockGetSessionUser,
  mockIsAppBlocksAuthorEnabled,
  mockRecordScopeInvocation,
} = vi.hoisted(() => {
  const mockClient = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
  const mockPool = {
    connect: vi.fn(async () => mockClient),
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  };
  return {
    mockVerifyBlockToken: vi.fn(),
    mockParseSubjectUserId: vi.fn(),
    mockDbRead: {
      appBlock: { findUnique: vi.fn() },
      // Run-for-real storage reads the pubreq status (orphan guard) from the
      // PRIMARY (dbWrite, mapped to this mock below).
      appBlockPublishRequest: { findUnique: vi.fn() },
    },
    mockIsAppBlocksEnabled: vi.fn(async () => true),
    mockPool,
    mockClient,
    mockGetQuota: vi.fn(),
    // Mirrors the real AppStorageProvisioner.provisionReviewPreview: derives the
    // disposable `apprev_<norm>` schema from the publishRequestId (so isolation
    // tests can assert distinct schemas) without touching a real DB.
    mockProvisionReviewPreview: vi.fn(async ({ publishRequestId }: { publishRequestId: string }) => ({
      schema: `"apprev_${publishRequestId.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 48)}"`,
    })),
    mockLogToAxiom: vi.fn(async () => undefined),
    mockGetUserById: vi.fn(),
    mockGetSessionUser: vi.fn(),
    mockIsAppBlocksAuthorEnabled: vi.fn(),
    mockRecordScopeInvocation: vi.fn(async () => undefined),
  };
});

// W13 — the set/delete happy paths fire recordScopeInvocation (detached) with a
// structured `detail`. Mock it so the detached write settles promptly AND we can
// assert the emitted detail without a real DB.
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: (...args: unknown[]) => mockRecordScopeInvocation(...args),
}));

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...args: unknown[]) => mockParseSubjectUserId(...args),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbRead,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...args: unknown[]) => mockGetSessionUser(...args) },
}));
vi.mock('~/server/db/appsDb', () => ({
  requireAppsDb: () => mockPool,
}));
vi.mock('~/server/services/apps/storage-provision.service', () => ({
  AppStorageProvisioner: {
    getQuota: (...args: unknown[]) => mockGetQuota(...args),
    provisionReviewPreview: (...args: unknown[]) => mockProvisionReviewPreview(...args),
  },
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => mockLogToAxiom(...args),
}));
vi.mock('~/server/services/user.service', () => ({
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
}));

import { appsRouter } from '../apps.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function validClaims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'jti_test',
    blockId: 'generate-from-model',
    appId: 'app_test',
    blockInstanceId: 'mbi_inst',
    ctx: { modelId: 7, slotId: 'model.sidebar_top' },
    // Fix 3 / audit A5: storage is now a declared scope. The default claims
    // carry both read+write so the existing happy-path tests exercise the data
    // path; the scope-gate tests below override `scopes` to assert rejection.
    scopes: ['apps:storage:read', 'apps:storage:write'],
    ...over,
  };
}

function fakeCtx() {
  return {
    acceptableOrigin: true,
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

beforeEach(() => {
  mockVerifyBlockToken.mockReset();
  mockParseSubjectUserId.mockReset();
  mockDbRead.appBlock.findUnique.mockReset();
  mockIsAppBlocksEnabled.mockReset();
  mockPool.connect.mockClear();
  mockPool.query.mockReset();
  mockClient.query.mockReset();
  mockClient.release.mockClear();
  mockGetQuota.mockReset();
  mockLogToAxiom.mockReset();
  mockGetUserById.mockReset();
  mockGetSessionUser.mockReset();
  mockIsAppBlocksAuthorEnabled.mockReset();
  mockRecordScopeInvocation.mockReset();
  mockRecordScopeInvocation.mockResolvedValue(undefined);
  // mockClear (NOT mockReset) — preserve the derive-schema implementation set in
  // the hoisted factory while clearing call history between tests.
  mockProvisionReviewPreview.mockClear();

  // Sane defaults the happy-path tests inherit.
  mockIsAppBlocksEnabled.mockImplementation(async () => true);
  mockParseSubjectUserId.mockImplementation((sub: string) => (sub === 'anon' ? null : 42));
  // The storage resolver re-asserts the resolved viewer is an app AUTHOR
  // (assertViewerIsAppDeveloper → getSessionUserById + isAppBlocksAuthorEnabled).
  // Default the happy path to a moderator subject; the author capability defaults
  // to the mod-floor (mirrors the flag absent → mods pass, non-mods don't).
  mockGetUserById.mockResolvedValue({ id: 42, isModerator: true });
  mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: true });
  mockIsAppBlocksAuthorEnabled.mockImplementation(
    async (opts?: { user?: { isModerator?: boolean } }) => !!opts?.user?.isModerator
  );
  mockDbRead.appBlock.findUnique.mockResolvedValue({
    id: 'apb_test',
    status: 'approved',
  });
  // Default the pubreq to PENDING so run-for-real happy paths resolve; the orphan
  // guard tests override with a non-pending / missing status.
  mockDbRead.appBlockPublishRequest.findUnique.mockReset();
  mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValue({ status: 'pending' });
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mockLogToAxiom.mockResolvedValue(undefined);
});

describe('apps.storage shared gates', () => {
  it('rejects when the Flipt flag is dark', async () => {
    mockIsAppBlocksEnabled.mockImplementationOnce(async () => false);
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(caller.storage.get({ blockToken: 't', key: 'k' })).rejects.toBeInstanceOf(
      TRPCError
    );
  });

  it('rejects an invalid block token with UNAUTHORIZED', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(null);
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.get({ blockToken: 't', key: 'k' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects when the AppBlock row is missing (NOT_FOUND)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockDbRead.appBlock.findUnique.mockResolvedValueOnce(null);
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.get({ blockToken: 't', key: 'k' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects when the AppBlock status is not approved (FORBIDDEN)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockDbRead.appBlock.findUnique.mockResolvedValueOnce({
      id: 'apb_pending',
      status: 'pending',
    });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.get({ blockToken: 't', key: 'k' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a blockId that doesnt sanitize to a valid slug', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ blockId: '!!' }));
    mockDbRead.appBlock.findUnique.mockResolvedValueOnce({
      id: 'apb_test',
      status: 'approved',
    });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.get({ blockToken: 't', key: 'k' })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  // App Blocks authoring is mod OR the app-dev-testers cohort. A block token
  // whose subject resolves to a non-author (non-mod, no cohort grant) is rejected
  // with FORBIDDEN by the shared resolveStorageContext gate — across every op.
  it('rejects a non-mod resolved viewer with FORBIDDEN (get)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetSessionUser.mockResolvedValueOnce({ id: 42, isModerator: false });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.get({ blockToken: 't', key: 'k' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The non-mod must never reach the data pool.
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('rejects a non-mod resolved viewer with FORBIDDEN (set)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetSessionUser.mockResolvedValueOnce({ id: 42, isModerator: false });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: { a: 1 } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it('rejects a vanished resolved viewer with FORBIDDEN (getSessionUserById → null)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetSessionUser.mockResolvedValueOnce(null);
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.get({ blockToken: 't', key: 'k' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('accepts an author-capable NON-MOD subject (cohort widening): reaches the data pool', async () => {
    // A curated non-mod author (granted app-blocks-author) whose block declares
    // apps:storage:* must NOT be blocked at the storage gate — the KV op proceeds.
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetSessionUser.mockResolvedValueOnce({ id: 42, isModerator: false });
    mockIsAppBlocksAuthorEnabled.mockResolvedValueOnce(true);
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await caller.storage.get({ blockToken: 't', key: 'k' });
    expect(mockPool.query).toHaveBeenCalled();
  });

  // Fix 3 / audit A5 (design-gaps H4): storage is a DECLARED, approved scope —
  // not an ambient capability. A block approved for some OTHER scope (e.g.
  // models:read:self) but NOT apps:storage:* must be denied at the storage
  // resolver before it touches appsDb.
  it('rejects a token without apps:storage:read on a read op (FORBIDDEN)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(
      validClaims({ scopes: ['models:read:self'] })
    );
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.get({ blockToken: 't', key: 'k' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The block with no storage scope must never reach the data pool.
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('rejects a token without apps:storage:write on a write op (FORBIDDEN)', async () => {
    // Read scope present, write scope absent → set/delete must still 403.
    mockVerifyBlockToken.mockResolvedValueOnce(
      validClaims({ scopes: ['apps:storage:read'] })
    );
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: { a: 1 } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('read scope alone is sufficient for a read op (no write needed)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(
      validClaims({ scopes: ['apps:storage:read'] })
    );
    mockPool.query.mockResolvedValueOnce({ rows: [{ value: 1 }], rowCount: 1 });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.get({ blockToken: 't', key: 'k' });
    expect(out).toEqual({ value: 1 });
  });

  it('rejects a delete without apps:storage:write (FORBIDDEN)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(
      validClaims({ scopes: ['apps:storage:read'] })
    );
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.delete({ blockToken: 't', key: 'k' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });
});

describe('apps.storage.get', () => {
  it('returns { value: null } for anon viewers (no per-anon storage in v0)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.get({ blockToken: 't', key: 'k' });
    expect(out).toEqual({ value: null });
    // anon path must not hit the DB pool
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('reads from the schema-scoped table and returns the stored value', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValueOnce({
      rows: [{ value: { hello: 'world' } }],
      rowCount: 1,
    });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.get({ blockToken: 't', key: 'lastPrompt' });
    expect(out).toEqual({ value: { hello: 'world' } });

    const sql = mockPool.query.mock.calls[0][0] as string;
    const params = mockPool.query.mock.calls[0][1] as unknown[];
    expect(sql).toContain('"app_generate_from_model".kv');
    expect(params).toEqual(['mbi_inst', 42, 'lastPrompt']);
  });

  it('returns { value: null } when the key isnt set', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    expect(await caller.storage.get({ blockToken: 't', key: 'k' })).toEqual({ value: null });
  });
});

describe('apps.storage.set', () => {
  it('refuses anon writes', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: { a: 1 } })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('rejects oversize values with PAYLOAD_TOO_LARGE', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    const big = 'x'.repeat(64 * 1024 + 1);
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: big })
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('rejects writes that would cross the 50MB quota', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    // quota nearly full
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ used_bytes: String(50 * 1024 * 1024 - 100), row_count: '1' }],
        rowCount: 1,
      })
      // no existing row for this key
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: 'x'.repeat(500) })
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', message: /quota/ });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('happy path commits the upsert inside a SET LOCAL transaction', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query
      // quota
      .mockResolvedValueOnce({
        rows: [{ used_bytes: '0', row_count: '0' }],
        rowCount: 1,
      })
      // existing row
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.set({
      blockToken: 't',
      key: 'lastPrompt',
      value: { v: 'cyberpunk cat' },
    });
    expect(out.ok).toBe(true);

    const sqls = (mockClient.query.mock.calls as Array<[string, unknown?]>).map(
      (call) => call[0]
    );
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(sqls.some((s) => s.startsWith('SET LOCAL app.current_app_block_id'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO "app_generate_from_model".kv'))).toBe(true);
    expect(mockClient.release).toHaveBeenCalledOnce();

    // W13 — emits a storage.set detail carrying the key.
    await vi.waitFor(() => expect(mockRecordScopeInvocation).toHaveBeenCalled());
    expect(mockRecordScopeInvocation.mock.calls[0][0]).toMatchObject({
      scope: 'apps:storage',
      detail: { action: 'storage.set', key: 'lastPrompt', outcome: 'ok' },
    });
  });

  it('uses the net delta from an existing row to size the quota check', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    // Pretend used_bytes is the per-app limit; the only reason this write
    // is allowed to land is the existing row's old size shrinks to the
    // new value.
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{ used_bytes: String(50 * 1024 * 1024), row_count: '1' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ size_bytes: 5000 }], rowCount: 1 });

    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: 'short' })
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('apps.storage.delete', () => {
  it('refuses anon deletes', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(caller.storage.delete({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('reports deleted: false when nothing matched', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DELETE')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.delete({ blockToken: 't', key: 'k' });
    expect(out).toEqual({ ok: true, deleted: false });
  });

  it('reports deleted: true when the row existed', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DELETE')) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.delete({ blockToken: 't', key: 'k' });
    expect(out).toEqual({ ok: true, deleted: true });

    // W13 — emits a storage.delete detail carrying the key (only on real deletion).
    await vi.waitFor(() => expect(mockRecordScopeInvocation).toHaveBeenCalled());
    expect(mockRecordScopeInvocation.mock.calls[0][0]).toMatchObject({
      scope: 'apps:storage',
      detail: { action: 'storage.delete', key: 'k', outcome: 'ok' },
    });
  });

  it('emits NO audit row (and no detail) when nothing was deleted', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DELETE')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await caller.storage.delete({ blockToken: 't', key: 'k' });
    // Give any (incorrectly) detached write a tick to fire — it must not.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRecordScopeInvocation).not.toHaveBeenCalled();
  });
});

describe('apps.storage.list', () => {
  it('returns empty for anon viewers', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.list({ blockToken: 't' });
    expect(out).toEqual({ keys: [], nextCursor: undefined });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('emits nextCursor only when the page filled', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { key: 'a', updated_at: new Date('2026-01-01T00:00:00Z') },
        { key: 'b', updated_at: new Date('2026-01-02T00:00:00Z') },
      ],
      rowCount: 2,
    });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.list({ blockToken: 't', limit: 2 });
    expect(out.keys.map((k) => k.key)).toEqual(['a', 'b']);
    expect(out.nextCursor).toBe(Buffer.from('b', 'utf8').toString('base64'));
  });

  it('omits nextCursor when partial page', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValueOnce({
      rows: [{ key: 'a', updated_at: new Date() }],
      rowCount: 1,
    });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.list({ blockToken: 't', limit: 5 });
    expect(out.nextCursor).toBeUndefined();
  });

  it('escapes LIKE wildcards in the user-supplied prefix', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await caller.storage.list({ blockToken: 't', prefix: '50%_off' });
    const params = mockPool.query.mock.calls[0][1] as unknown[];
    expect(params[2]).toBe('50\\%\\_off%');
  });
});

describe('apps.storage.getQuota', () => {
  it('proxies the provisioner snapshot + ships the v0 limits', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetQuota.mockResolvedValueOnce({ usedBytes: 12345, rowCount: 7 });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.getQuota({ blockToken: 't' });
    expect(out).toEqual({
      usedBytes: 12345,
      rowCount: 7,
      limitBytes: 50 * 1024 * 1024,
      limitRows: 1_000_000,
    });
    expect(mockGetQuota).toHaveBeenCalledWith({
      slug: 'generate_from_model',
      appBlockId: 'apb_test',
    });
  });

  it('returns zeroes when the schema isnt provisioned yet', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetQuota.mockResolvedValueOnce(null);
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.getQuota({ blockToken: 't' });
    expect(out.usedBytes).toBe(0);
    expect(out.rowCount).toBe(0);
  });
});

// ── MOD REVIEW SANDBOX "run for real" preview storage (#2831) ────────────────
// A run-for-real review token (signed `reviewRunForReal`) makes per-user storage
// WORK for a PENDING app via a disposable, per-publishRequest, ISOLATED preview
// schema — self-bound to the mod, never touching the approved app's namespace.
describe('apps.storage — run-for-real preview namespace', () => {
  // A review run-for-real token: synthetic pending ids + the signed claim.
  function reviewClaims(over: Record<string, unknown> = {}) {
    return validClaims({
      reviewRunForReal: true,
      appId: 'pending-pubreq_aaa',
      appBlockId: 'pubreq_aaa',
      blockInstanceId: 'page_pubreq_aaa',
      blockId: 'generate-from-model',
      ...over,
    });
  }

  it('GET succeeds for a PENDING app: resolves the apprev_ preview schema, never the AppBlock lookup', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(reviewClaims());
    mockPool.query.mockResolvedValueOnce({ rows: [{ value: { hello: 'world' } }], rowCount: 1 });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.get({ blockToken: 't', key: 'k' });
    expect(out.value).toEqual({ hello: 'world' });
    // The preview schema was provisioned on demand for THIS publish request.
    expect(mockProvisionReviewPreview).toHaveBeenCalledWith({ publishRequestId: 'pubreq_aaa' });
    // The read hit the DISPOSABLE preview schema — NOT the approved app schema.
    const sql = String(mockPool.query.mock.calls.at(-1)?.[0]);
    expect(sql).toContain('"apprev_pubreqaaa".kv');
    expect(sql).not.toContain('app_generate_from_model');
    // The run-for-real path NEVER consults the AppBlock row (the app is unapproved).
    expect(mockDbRead.appBlock.findUnique).not.toHaveBeenCalled();
  });

  it('SET succeeds for a PENDING app: writes to the preview schema, self-bound to the mod', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(reviewClaims());
    // quota pre-read + existing-size read → both empty (fresh key, under quota).
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const res = await caller.storage.set({ blockToken: 't', key: 'note', value: { a: 1 } });
    expect(res.ok).toBe(true);
    expect(mockProvisionReviewPreview).toHaveBeenCalledWith({ publishRequestId: 'pubreq_aaa' });
    // The INSERT (client.query) targeted the preview schema, self-bound to user 42.
    const insertCall = mockClient.query.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO')
    );
    expect(insertCall).toBeTruthy();
    expect(String(insertCall?.[0])).toContain('"apprev_pubreqaaa".kv');
    expect(String(insertCall?.[0])).not.toContain('app_generate_from_model');
    // The quota GUC is set to the publishRequestId (preview quota row key).
    const setLocalCall = mockClient.query.mock.calls.find((c) =>
      String(c[0]).includes('SET LOCAL app.current_app_block_id')
    );
    expect(String(setLocalCall?.[0])).toContain('pubreq_aaa');
    expect(insertCall?.[1]).toEqual(['page_pubreq_aaa', 42, 'note', JSON.stringify({ a: 1 })]);
  });

  it('ISOLATION: two pending apps resolve DISTINCT preview schemas; neither aliases the approved app schema', async () => {
    // App A.
    mockVerifyBlockToken.mockResolvedValueOnce(reviewClaims({ appBlockId: 'pubreq_aaa' }));
    mockPool.query.mockResolvedValueOnce({ rows: [{ value: 1 }], rowCount: 1 });
    let caller = appsRouter.createCaller(fakeCtx() as never);
    await caller.storage.get({ blockToken: 't', key: 'k' });
    const sqlA = String(mockPool.query.mock.calls.at(-1)?.[0]);

    // App B — different publish request, SAME slug.
    mockVerifyBlockToken.mockResolvedValueOnce(reviewClaims({ appBlockId: 'pubreq_bbb' }));
    mockPool.query.mockResolvedValueOnce({ rows: [{ value: 2 }], rowCount: 1 });
    caller = appsRouter.createCaller(fakeCtx() as never);
    await caller.storage.get({ blockToken: 't', key: 'k' });
    const sqlB = String(mockPool.query.mock.calls.at(-1)?.[0]);

    expect(sqlA).toContain('"apprev_pubreqaaa".kv');
    expect(sqlB).toContain('"apprev_pubreqbbb".kv');
    // A cannot resolve B's namespace, and neither is the approved app schema —
    // preview writes never pollute the eventual approved `app_<slug>` store.
    expect(sqlA).not.toContain('apprev_pubreqbbb');
    expect(sqlB).not.toContain('apprev_pubreqaaa');
    expect(sqlA).not.toContain('app_generate_from_model');
    expect(sqlB).not.toContain('app_generate_from_model');
  });

  it('REGRESSION: WITHOUT the run-for-real claim, a pending app still FAILS CLOSED (no preview schema)', async () => {
    // Same synthetic pending token but NO reviewRunForReal → the approved-status
    // gate runs and rejects; the preview namespace is never provisioned.
    mockVerifyBlockToken.mockResolvedValueOnce(
      validClaims({ appId: 'pending-pubreq_aaa', appBlockId: 'pubreq_aaa', blockId: 'generate-from-model' })
    );
    mockDbRead.appBlock.findUnique.mockResolvedValueOnce({ id: 'apb_x', status: 'pending' });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: { a: 1 } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockProvisionReviewPreview).not.toHaveBeenCalled();
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it('the storage SCOPE gate still applies under run-for-real (write needs apps:storage:write)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(
      reviewClaims({ scopes: ['apps:storage:read'] }) // read-only → set must reject
    );
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: { a: 1 } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Rejected at the scope gate BEFORE provisioning any preview schema.
    expect(mockProvisionReviewPreview).not.toHaveBeenCalled();
  });

  it('run-for-real is SELF-BOUND: an anon subject cannot write preview storage', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(reviewClaims({ sub: 'anon' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: { a: 1 } })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('ORPHAN GUARD: a valid run-for-real token used AFTER approve/reject does NOT re-provision', async () => {
    // The 4h token is still valid, but the request has left pending → the preview
    // is gone; refuse and NEVER re-provision a schema nothing would tear down.
    mockVerifyBlockToken.mockResolvedValueOnce(reviewClaims());
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValueOnce({ status: 'approved' });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: { a: 1 } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockProvisionReviewPreview).not.toHaveBeenCalled();
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it('ORPHAN GUARD: a run-for-real token for a VANISHED request refuses (no re-provision)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(reviewClaims());
    mockDbRead.appBlockPublishRequest.findUnique.mockResolvedValueOnce(null);
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.get({ blockToken: 't', key: 'k' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockProvisionReviewPreview).not.toHaveBeenCalled();
  });
});
