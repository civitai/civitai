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
  mockIsRevoked,
  mockGetUserQuota,
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
    mockIsRevoked: vi.fn(async () => false),
    mockGetUserQuota: vi.fn(),
  };
});

vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: (...args: unknown[]) => mockIsRevoked(...args) },
}));

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
    getUserQuota: (...args: unknown[]) => mockGetUserQuota(...args),
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
// Globally stubbed in src/__tests__/setup.ts (promMetricStub) — `.inc` is a
// vi.fn(), so the refusal-instrumentation assertions below can read it.
import { appStorageOpsCounter } from '~/server/prom/client';

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

/**
 * The `app-blocks-enabled` (RUN) cohort, by user id. The mock flag evaluator
 * below reads this set, so a test can enable/disable the capability for the
 * SESSION user and for the TOKEN SUBJECT independently — which is the only way
 * to tell the `enforceAppBlocksFlag` middleware (evaluates `ctx.user`) apart
 * from the per-subject assertion inside `resolveStorageContext`. Both refuse
 * with the same code AND the same message, so a test that leaves the two
 * identities equal can pass for the wrong reason.
 */
const runEnabledUserIds = new Set<number>();

/** The SESSION user on the host page — distinct id from the token subject where
 *  a test needs to isolate which of the two gates fired. */
const SESSION_USER = { id: 1, isModerator: false, tier: 'free' };

function fakeCtx(user: unknown = SESSION_USER) {
  return {
    acceptableOrigin: true,
    user,
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
  mockGetUserQuota.mockReset();
  mockIsRevoked.mockReset();
  mockIsRevoked.mockResolvedValue(false);
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
  // The RUN capability (`app-blocks-enabled`) is per-user: it is evaluated once
  // by the middleware against `ctx.user` and once by resolveStorageContext
  // against the TOKEN SUBJECT. Model it as a cohort membership so those two
  // evaluations can disagree. A user-less eval returns false here, matching the
  // live base-false flag — but that is NOT what makes production fail closed on
  // a vanished subject: both capability gates now throw on an explicit null
  // check before any flag evaluation, so this mock's no-user answer is never
  // reached on that path (see the `unhydratable subject` blocks below, which
  // pin the refusal under a base-TRUE flag too).
  runEnabledUserIds.clear();
  runEnabledUserIds.add(SESSION_USER.id);
  runEnabledUserIds.add(42);
  mockIsAppBlocksEnabled.mockImplementation(async (opts?: { user?: { id?: number } }) => {
    const id = opts?.user?.id;
    return id != null && runEnabledUserIds.has(id);
  });
  mockParseSubjectUserId.mockImplementation((sub: string) => (sub === 'anon' ? null : 42));
  // The storage resolver hydrates the token subject (getSessionUserById) and
  // asserts a capability against it. Default the happy path to a moderator
  // subject, who holds every capability; the author capability defaults to the
  // mod-floor (mirrors the flag absent → mods pass, non-mods don't).
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
    mockIsAppBlocksEnabled.mockImplementation(async () => false);
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

  // A revoked instance must lose storage access IMMEDIATELY, not at token expiry.
  // Every op, not just the writes: a read of the user's own rows is still access
  // granted by an install that no longer exists.
  it.each([
    ['get', (c: ReturnType<typeof appsRouter.createCaller>) => c.storage.get({ blockToken: 't', key: 'k' })],
    ['set', (c: ReturnType<typeof appsRouter.createCaller>) => c.storage.set({ blockToken: 't', key: 'k', value: 'v' })],
    ['delete', (c: ReturnType<typeof appsRouter.createCaller>) => c.storage.delete({ blockToken: 't', key: 'k' })],
    ['list', (c: ReturnType<typeof appsRouter.createCaller>) => c.storage.list({ blockToken: 't' })],
    ['getQuota', (c: ReturnType<typeof appsRouter.createCaller>) => c.storage.getQuota({ blockToken: 't' })],
  ] as const)('rejects a revoked block instance on %s', async (_op, call) => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockIsRevoked.mockResolvedValueOnce(true);
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(call(caller)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'block instance revoked',
    });
    // Refused before any datastore access — not merely refused on the way out.
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('checks revocation against the token claim, and lets a live instance through', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValueOnce({ rows: [{ value: 1 }], rowCount: 1 });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(caller.storage.get({ blockToken: 't', key: 'k' })).resolves.toEqual({ value: 1 });
    expect(mockIsRevoked).toHaveBeenCalledWith('mbi_inst');
  });

  // The run-for-real review branch returns before the approved-app checks, so it
  // needs its own case: a revocation placed after that branch would not bind it.
  it('rejects a revoked instance on the run-for-real preview branch too', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(
      validClaims({ reviewRunForReal: true, appBlockId: 'pubreq_01hzzz' })
    );
    mockIsRevoked.mockResolvedValueOnce(true);
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(caller.storage.get({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'block instance revoked',
    });
    expect(mockProvisionReviewPreview).not.toHaveBeenCalled();
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

  // ── Per-user storage is gated on the RUN capability, not the AUTHOR one ──────
  //
  // REGRESSION (the defect): the shared resolver used to assert the AUTHORING
  // capability (`app-blocks-author`) against the token subject. Once the run
  // cohort widened past the author cohort, a user who could legitimately open an
  // app got FORBIDDEN on all five storage ops — so no stateful app could save
  // anything, and could not read back what it had already saved. Reading/writing
  // your OWN data inside an app you are allowed to run is a consumer capability.
  it('a NON-AUTHOR subject holding the run capability can READ its own storage', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    // Not an author: no mod floor, and the author cohort refuses this subject.
    mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: false });
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    mockPool.query.mockResolvedValueOnce({ rows: [{ value: { saved: true } }], rowCount: 1 });

    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.get({ blockToken: 't', key: 'k' });

    expect(out).toEqual({ value: { saved: true } });
    expect(mockPool.query).toHaveBeenCalled();
  });

  it('a NON-AUTHOR subject holding the run capability can WRITE its own storage', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: false });
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    mockPool.query
      // quota row
      .mockResolvedValueOnce({ rows: [{ used_bytes: '0', row_count: '0' }], rowCount: 1 })
      // no existing row for this key
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.set({ blockToken: 't', key: 'k', value: { a: 1 } });

    expect(out.ok).toBe(true);
    const sqls = (mockClient.query.mock.calls as Array<[string, unknown?]>).map((c) => c[0]);
    expect(sqls.some((s) => s.includes('INSERT INTO "app_generate_from_model".kv'))).toBe(true);
  });

  // KILL-SWITCH, still fail-closed. The subject id differs from the session
  // user's so ONLY the per-subject assertion can produce this refusal — the
  // middleware sees a run-enabled `ctx.user` and passes. Both gates throw the
  // same code and message, so without that split this test would pass even if
  // the per-subject assertion were deleted outright.
  it('refuses a subject WITHOUT the run capability, even when the session user has it (get)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:77' }));
    mockParseSubjectUserId.mockImplementation(() => 77);
    mockGetSessionUser.mockResolvedValue({ id: 77, isModerator: false });
    runEnabledUserIds.delete(77); // session user (id 1) stays enabled

    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(caller.storage.get({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Apps are not enabled',
    });
    // Proof the middleware let this through and the SUBJECT gate is what refused:
    // the token was verified and the subject was hydrated before the throw.
    expect(mockVerifyBlockToken).toHaveBeenCalled();
    expect(mockGetSessionUser).toHaveBeenCalledWith(77);
    // The refused subject must never reach the data pool.
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('refuses a subject WITHOUT the run capability, even when the session user has it (set)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:77' }));
    mockParseSubjectUserId.mockImplementation(() => 77);
    mockGetSessionUser.mockResolvedValue({ id: 77, isModerator: false });
    runEnabledUserIds.delete(77);

    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: { a: 1 } })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
    expect(mockGetSessionUser).toHaveBeenCalledWith(77);
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  // Positive control for the pair above: the ONLY thing that changed is the
  // subject's cohort membership, so if the assertion above were inert this case
  // would be indistinguishable from it.
  it('the same subject IS admitted once it holds the run capability', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:77' }));
    mockParseSubjectUserId.mockImplementation(() => 77);
    mockGetSessionUser.mockResolvedValue({ id: 77, isModerator: false });
    runEnabledUserIds.add(77);
    mockPool.query.mockResolvedValueOnce({ rows: [{ value: 1 }], rowCount: 1 });

    const caller = appsRouter.createCaller(fakeCtx() as never);
    expect(await caller.storage.get({ blockToken: 't', key: 'k' })).toEqual({ value: 1 });
  });

  // ── Fail-closed on an unhydratable subject ──────────────────────────────────
  // Audit 🟡-2. A subject the session hub cannot resolve (deleted account,
  // transient miss) must be refused by an EXPLICIT null check, not by whatever
  // `app-blocks-enabled` happens to evaluate to when it is handed no user.
  // Handing it `undefined` takes the no-user GLOBAL eval, which refuses today
  // only because the live flag is base-`false`; a plain base-`enabled: true`
  // flag matches every entityId including the contextless global one.
  //
  // So the property is measured at BOTH points on the flag-config dimension:
  // base-false (today) and base-true (the documented GA shape). The second case
  // is the structural one — it fails against a gate that leans on the flag.
  describe('unhydratable subject', () => {
    beforeEach(() => {
      mockParseSubjectUserId.mockImplementation(() => 77);
      // A vanished subject: the token is valid and its `sub` parses, but the
      // hub has no user for it.
      mockGetSessionUser.mockResolvedValue(null);
    });

    it('is refused under TODAY\'s base-false flag (get)', async () => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:77' }));

      const caller = appsRouter.createCaller(fakeCtx() as never);
      await expect(caller.storage.get({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        // The null guard's OWN message, not the flag gate's 'Apps are not
        // enabled' — pinning which of the two refusals fired.
        message: 'block token subject could not be resolved',
      });
      expect(mockGetSessionUser).toHaveBeenCalledWith(77);
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    // The POST-GA model: `app-blocks-enabled` is base-`enabled: true`, so it
    // resolves TRUE for every eval — including the no-user global eval a null
    // subject would produce. A gate whose fail-closed is only spelled (pass
    // `undefined`, let the flag say no) ADMITS here and lets `get` read and
    // `set` write on the vanished subject's behalf.
    const baseTrueFlag = async () => true;

    it('is STILL refused when the flag evaluates TRUE for a null user (base-true / GA shape, get)', async () => {
      mockIsAppBlocksEnabled.mockImplementation(baseTrueFlag);
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:77' }));
      // A row is waiting: if the gate admits, the op succeeds and returns it,
      // so this case cannot pass by the query merely being empty.
      mockPool.query.mockResolvedValue({ rows: [{ value: 'other-users-row' }], rowCount: 1 });

      const caller = appsRouter.createCaller(fakeCtx() as never);
      await expect(caller.storage.get({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'block token subject could not be resolved',
      });
      expect(mockGetSessionUser).toHaveBeenCalledWith(77);
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('is STILL refused when the flag evaluates TRUE for a null user (base-true / GA shape, set)', async () => {
      mockIsAppBlocksEnabled.mockImplementation(baseTrueFlag);
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:77' }));

      const caller = appsRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.storage.set({ blockToken: 't', key: 'k', value: { a: 1 } })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'block token subject could not be resolved',
      });
      // No row is written on the vanished subject's behalf.
      expect(mockPool.connect).not.toHaveBeenCalled();
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    // POSITIVE CONTROL for the two cases above. Same base-true flag mock, same
    // subject id — the ONLY thing that changes is that the subject hydrates. If
    // the guard refused unconditionally (or the base-true mock were not
    // actually reaching the gate), this would fail too and the pair above would
    // prove nothing.
    it('admits a subject that DOES hydrate, under the same base-true flag', async () => {
      mockIsAppBlocksEnabled.mockImplementation(baseTrueFlag);
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:77' }));
      mockGetSessionUser.mockResolvedValue({ id: 77, isModerator: false });
      mockPool.query.mockResolvedValueOnce({ rows: [{ value: 1 }], rowCount: 1 });

      const caller = appsRouter.createCaller(fakeCtx() as never);
      expect(await caller.storage.get({ blockToken: 't', key: 'k' })).toEqual({ value: 1 });
    });

    // Audit 🟡-4: every other refusal in resolveStorageContext increments the
    // ops counter; the capability refusals did not, which is why the defect
    // behind this change was only visible in a raw request log.
    it('counts the refusal on the ops counter (op + outcome)', async () => {
      const inc = vi.mocked(appStorageOpsCounter.inc);
      inc.mockClear();
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:77' }));

      const caller = appsRouter.createCaller(fakeCtx() as never);
      await expect(caller.storage.get({ blockToken: 't', key: 'k' })).rejects.toBeInstanceOf(
        TRPCError
      );
      expect(inc).toHaveBeenCalledWith({ op: 'get', outcome: 'unauthorized' });
    });
  });

  // The OTHER capability refusal on this path — subject hydrates, but does not
  // hold the run capability — must be counted too (audit 🟡-4).
  it('counts a run-capability refusal on the ops counter', async () => {
    const inc = vi.mocked(appStorageOpsCounter.inc);
    inc.mockClear();
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:77' }));
    mockParseSubjectUserId.mockImplementation(() => 77);
    mockGetSessionUser.mockResolvedValue({ id: 77, isModerator: false });
    runEnabledUserIds.delete(77);

    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: { a: 1 } })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
    expect(inc).toHaveBeenCalledWith({ op: 'set', outcome: 'unauthorized' });
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
      // BOUNDED aggregation key — the key must NOT be interpolated into it.
      endpoint: 'storage:set',
      detail: { action: 'storage.set', key: 'lastPrompt', outcome: 'ok' },
    });
  });

  // 🔴 Cardinality: `block_scope_invocations.endpoint` is the GROUP BY key of
  // the `topEndpoints` rollup, so a per-key endpoint made it unbounded (every
  // bucket count 1). Two writes to DIFFERENT keys must collapse to one endpoint
  // value; the key survives in `detail`, which is what the UI reads.
  it('two different storage keys AGGREGATE to one endpoint value, keys kept in detail', async () => {
    for (const key of ['alpha', 'beta']) {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      mockPool.query
        .mockResolvedValueOnce({ rows: [{ used_bytes: '0', row_count: '0' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const caller = appsRouter.createCaller(fakeCtx() as never);
      await caller.storage.set({ blockToken: 't', key, value: 'v' });
    }
    await vi.waitFor(() =>
      expect(mockRecordScopeInvocation.mock.calls.length).toBeGreaterThanOrEqual(2)
    );
    const calls = mockRecordScopeInvocation.mock.calls.map(
      (c) => c[0] as { endpoint: string; detail?: { key?: string } }
    );
    expect(new Set(calls.map((c) => c.endpoint))).toEqual(new Set(['storage:set']));
    expect(calls.map((c) => c.detail?.key)).toEqual(['alpha', 'beta']);
  });

  // ── Per-USER sub-budget ────────────────────────────────────────────────────
  // Literals, not imports from the router: an expectation derived from the
  // constant it tests moves with the constant and asserts nothing.
  const USER_CAP_BYTES = 1024 * 1024;
  const USER_CAP_ROWS = 1_000;
  const APP_CAP_BYTES = 50 * 1024 * 1024;

  /** App budget with plenty of room; per-user usage supplied per subject id. */
  function quotaPoolFor(userBytes: Record<number, number>, userRows: Record<number, number> = {}) {
    return async (sql: string, params?: unknown[]) => {
      if (sql.includes('.quota q')) {
        const uid = Number((params ?? [])[1]);
        return {
          rows: [
            {
              used_bytes: String(40 * 1024 * 1024),
              row_count: '2000',
              user_used_bytes: String(userBytes[uid] ?? 0),
              user_row_count: String(userRows[uid] ?? 0),
            },
          ],
          rowCount: 1,
        };
      }
      // The existing-row lookup: fresh key, so no row.
      return { rows: [], rowCount: 0 };
    };
  }

  /** Route the subject id through the token's `sub` so two users can be modelled. */
  function useSubjectFromSub() {
    mockParseSubjectUserId.mockImplementation((sub: string) =>
      sub === 'anon' ? null : Number(String(sub).split(':')[1])
    );
    mockGetSessionUser.mockImplementation(async (id: number) => ({ id, isModerator: false }));
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    runEnabledUserIds.add(43);
  }

  // The whole point of the sub-budget: one user exhausting their own cap must
  // NOT consume the app budget the rest of the app's users depend on. Both legs
  // run against the SAME app state, in one test — the relationship is the claim,
  // and two independently-passing tests would not pin it.
  it('refuses the user at their cap while another user of the SAME app still writes', async () => {
    useSubjectFromSub();
    mockPool.query.mockImplementation(quotaPoolFor({ 42: USER_CAP_BYTES - 10, 43: 0 }));

    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:42' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: 'x'.repeat(500) })
    ).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'per-user storage quota exceeded',
    });

    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:43' }));
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: 'x'.repeat(500) })
    ).resolves.toMatchObject({ ok: true });
  });

  // Reachability: the refusal must come from the per-user gate on an input that
  // clears every earlier check, including the app-wide one. 500 bytes against a
  // 40MB/50MB app is nowhere near the app ceiling, so only the sub-budget can
  // refuse it.
  it('the app-wide gate would ALLOW the write the per-user gate refuses', async () => {
    useSubjectFromSub();
    mockPool.query.mockImplementation(quotaPoolFor({ 42: USER_CAP_BYTES - 10 }));
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:42' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: 'x'.repeat(500) })
    ).rejects.toMatchObject({ message: 'per-user storage quota exceeded' });
    // App headroom at the moment of refusal, stated so the test carries its scope.
    expect(40 * 1024 * 1024 + 500).toBeLessThan(APP_CAP_BYTES);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('allows a write that fits inside the per-user cap', async () => {
    useSubjectFromSub();
    mockPool.query.mockImplementation(quotaPoolFor({ 42: USER_CAP_BYTES - 4096 }));
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:42' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: 'x'.repeat(500) })
    ).resolves.toMatchObject({ ok: true });
  });

  it('refuses an INSERT past the per-user row cap', async () => {
    useSubjectFromSub();
    mockPool.query.mockImplementation(quotaPoolFor({ 42: 0 }, { 42: USER_CAP_ROWS }));
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:42' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: 'v' })
    ).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'per-user row limit exceeded',
    });
  });

  // An in-place shrink at the row cap is an UPDATE, not an INSERT — it must not
  // be refused, or a user at their row cap can never edit what they already have.
  it('lets a user at the row cap overwrite an existing key', async () => {
    useSubjectFromSub();
    mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('.quota q')) {
        const uid = Number((params ?? [])[1]);
        return {
          rows: [
            {
              used_bytes: '0',
              row_count: '0',
              user_used_bytes: uid === 42 ? String(USER_CAP_BYTES - 10) : '0',
              user_row_count: String(USER_CAP_ROWS),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [{ size_bytes: 5000 }], rowCount: 1 };
    });
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:42' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: 'short' })
    ).resolves.toMatchObject({ ok: true });
  });

  it('reads the per-user counter for the SUBJECT, keyed on the app not the instance', async () => {
    useSubjectFromSub();
    mockPool.query.mockImplementation(quotaPoolFor({ 42: 0 }));
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:42' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await caller.storage.set({ blockToken: 't', key: 'k', value: 'v' });
    const quotaCall = (mockPool.query.mock.calls as Array<[string, unknown[]]>).find(([s]) =>
      s.includes('.quota q')
    );
    expect(quotaCall?.[0]).toContain('user_quota');
    expect(quotaCall?.[1]).toEqual(['apb_test', 42]);
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
      // BOUNDED aggregation key — the key must NOT be interpolated into it.
      endpoint: 'storage:delete',
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
  it('reports the CALLERS own usage against the per-user caps', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetUserQuota.mockResolvedValueOnce({ usedBytes: 12345, rowCount: 7 });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.getQuota({ blockToken: 't' });
    expect(out).toEqual({
      usedBytes: 12345,
      rowCount: 7,
      limitBytes: 1024 * 1024,
      limitRows: 1_000,
    });
    expect(mockGetUserQuota).toHaveBeenCalledWith({
      slug: 'generate_from_model',
      appBlockId: 'apb_test',
      userId: 42,
    });
  });

  // The app aggregate sums other users' rows. This procedure is reachable by
  // everyone who may RUN the app, so it must not read that aggregate at all —
  // not merely decline to return it.
  it('never reads the app-wide aggregate', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetUserQuota.mockResolvedValueOnce({ usedBytes: 1, rowCount: 1 });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.getQuota({ blockToken: 't' });
    expect(mockGetQuota).not.toHaveBeenCalled();
    expect(out.limitBytes).toBe(1024 * 1024);
    expect(out.limitBytes).not.toBe(50 * 1024 * 1024);
  });

  it('returns zeroes when the schema isnt provisioned yet', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetUserQuota.mockResolvedValueOnce(null);
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.getQuota({ blockToken: 't' });
    expect(out.usedBytes).toBe(0);
    expect(out.rowCount).toBe(0);
  });

  it('returns zeroes for an anon subject without touching the datastore', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const out = await caller.storage.getQuota({ blockToken: 't' });
    expect(out).toEqual({
      usedBytes: 0,
      rowCount: 0,
      limitBytes: 1024 * 1024,
      limitRows: 1_000,
    });
    expect(mockGetUserQuota).not.toHaveBeenCalled();
    expect(mockGetQuota).not.toHaveBeenCalled();
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

  // INVARIANT GUARD (not a regression test — this behaviour is unchanged): the
  // review-preview branch is a reviewer action whose rows land in the reviewing
  // MOD's own namespace, so it keeps the AUTHORING gate. Widening the ordinary
  // per-user path to the run capability must not widen this one: a subject that
  // holds the run capability but is not an author is still refused here.
  it('review-preview still asserts the AUTHORING capability (run capability alone is not enough)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(reviewClaims());
    mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: false });
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(caller.storage.get({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Apps authoring is not enabled for this account',
    });
    expect(mockProvisionReviewPreview).not.toHaveBeenCalled();
    expect(mockPool.query).not.toHaveBeenCalled();
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

  // ── Fail-closed on an unhydratable subject, ON THIS BRANCH ──────────────────
  // This branch RETURNS before `assertAppBlocksEnabledForTokenUser` ever runs,
  // so `assertViewerIsAppDeveloper` is the ONLY subject check it makes — the
  // null guard on the other gate does not cover it, and a case on the ordinary
  // path does not exercise it.
  //
  // Measured at both points on the flag-config dimension: `app-blocks-author`
  // absent / base-false (today) and base-true. The second is the one that a
  // gate leaning on the flag fails — `isAppBlocksAuthorEnabled` has no mod floor
  // for a null user and falls through to a contextless GLOBAL eval, which a
  // plain base-`enabled: true` flag matches.
  describe('unhydratable subject on the review-preview branch', () => {
    beforeEach(() => {
      // Valid token whose `sub` parses, but the session hub has no user for it.
      mockGetSessionUser.mockResolvedValue(null);
    });

    it("is refused under TODAY's absent / base-false author flag (get)", async () => {
      mockVerifyBlockToken.mockResolvedValueOnce(reviewClaims());

      const caller = appsRouter.createCaller(fakeCtx() as never);
      await expect(caller.storage.get({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        // The null guard's OWN message, not the capability refusal's
        // 'Apps authoring is not enabled for this account' — pinning which of
        // the two refusals inside this gate fired.
        message: 'review token subject could not be resolved',
      });
      expect(mockGetSessionUser).toHaveBeenCalledWith(42);
      // Refused BEFORE the orphan-guard read and before any provisioning, i.e.
      // at the point in the branch where the subject is first known.
      expect(mockDbRead.appBlockPublishRequest.findUnique).not.toHaveBeenCalled();
      expect(mockProvisionReviewPreview).not.toHaveBeenCalled();
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    // The structural case: the author flag says YES even for a null user.
    const baseTrueAuthorFlag = async () => true;

    it('is STILL refused when the author flag evaluates TRUE for a null user (get)', async () => {
      mockIsAppBlocksAuthorEnabled.mockImplementation(baseTrueAuthorFlag);
      mockVerifyBlockToken.mockResolvedValueOnce(reviewClaims());
      // A row is waiting: if the gate admits, `get` resolves WITH it, so this
      // case cannot pass merely because the query returned nothing.
      mockPool.query.mockResolvedValue({ rows: [{ value: 'preview-row' }], rowCount: 1 });

      const caller = appsRouter.createCaller(fakeCtx() as never);
      await expect(caller.storage.get({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'review token subject could not be resolved',
      });
      expect(mockProvisionReviewPreview).not.toHaveBeenCalled();
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('is STILL refused when the author flag evaluates TRUE for a null user (set)', async () => {
      mockIsAppBlocksAuthorEnabled.mockImplementation(baseTrueAuthorFlag);
      mockVerifyBlockToken.mockResolvedValueOnce(reviewClaims());

      const caller = appsRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.storage.set({ blockToken: 't', key: 'k', value: { a: 1 } })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'review token subject could not be resolved',
      });
      // No preview schema provisioned, and no row written on the vanished
      // subject's behalf into the reviewing mod's namespace.
      expect(mockProvisionReviewPreview).not.toHaveBeenCalled();
      expect(mockPool.connect).not.toHaveBeenCalled();
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    // POSITIVE CONTROL for the pair above. Same base-true author mock, same
    // branch, same subject id — the ONLY change is that the subject hydrates.
    // If the guard refused unconditionally, or the base-true mock never reached
    // the gate, this would fail too and the pair above would prove nothing.
    it('admits a subject that DOES hydrate, under the same base-true author flag', async () => {
      mockIsAppBlocksAuthorEnabled.mockImplementation(baseTrueAuthorFlag);
      mockGetSessionUser.mockResolvedValue({ id: 42, isModerator: false });
      mockVerifyBlockToken.mockResolvedValueOnce(reviewClaims());
      mockPool.query.mockResolvedValue({ rows: [{ value: 'preview-row' }], rowCount: 1 });

      const caller = appsRouter.createCaller(fakeCtx() as never);
      const out = await caller.storage.get({ blockToken: 't', key: 'k' });

      expect(out.value).toBe('preview-row');
      expect(mockProvisionReviewPreview).toHaveBeenCalledWith({ publishRequestId: 'pubreq_aaa' });
    });

    // Every other refusal in resolveStorageContext increments the ops counter;
    // this one must too, or a valid token refused here is visible only in a raw
    // request log (audit 🟡-4). INVARIANT GUARD, not regression coverage for the
    // null check: this case also passed before the guard existed, because the
    // capability refusal it hit instead was already counted. What it does pin is
    // the new guard's OWN `inc` — deleting that line alone turns it red.
    it('counts the refusal on the ops counter (op + outcome)', async () => {
      const inc = vi.mocked(appStorageOpsCounter.inc);
      inc.mockClear();
      mockVerifyBlockToken.mockResolvedValueOnce(reviewClaims());

      const caller = appsRouter.createCaller(fakeCtx() as never);
      await expect(caller.storage.get({ blockToken: 't', key: 'k' })).rejects.toBeInstanceOf(
        TRPCError
      );
      expect(inc).toHaveBeenCalledWith({ op: 'get', outcome: 'unauthorized' });
    });
  });
});
