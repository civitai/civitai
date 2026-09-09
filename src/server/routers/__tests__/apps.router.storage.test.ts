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
import {
  appStorageOpsCounter,
  appStorageQuotaExceededCounter,
  appStorageUserQuotaUntrackedCounter,
} from '~/server/prom/client';

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

/**
 * The `set` path's stored-size probe:
 *   `SELECT octet_length($4::jsonb::text) AS new_size_bytes,
 *           (SELECT size_bytes FROM …) AS old_size_bytes`
 *
 * 🔴 BOTH NUMBERS ARE STORED BYTES — `octet_length(value::text)` over JSONB — and
 * that is NOT `Buffer.byteLength(JSON.stringify(value))`. Postgres' jsonb output
 * function emits `, ` after every separator and `: ` after every object key, so
 * for anything but a scalar the stored size is LARGER, by up to ~1.5x.
 *
 * That distinction is why this suite could not see the deploy-blocking defect it
 * was supposed to cover. Every fixture here used to supply `size_bytes` as a bare
 * number (61_440, 1_002, 5_000) that happened to be in the same unit as the wire
 * size of the value the test wrote, so the gate was never handed a real jsonb
 * size and a gate comparing the two units was indistinguishable from a correct
 * one. The pool is a mock, so NOTHING in this file can check the relationship
 * between the units — it is pinned against real Postgres in
 * `apps.router.storage.stored-units.behavior.test.ts`.
 *
 * What this file can do, and now does, is refuse to let the two units coincide by
 * accident: `oldStored` is always stated explicitly in the stored unit, and the
 * default `stored` below is a value no test's wire size equals.
 */
function sizeProbe(opts: { stored?: number; oldStored?: number | null } = {}) {
  return {
    rows: [
      {
        new_size_bytes: opts.stored ?? DEFAULT_STORED_BYTES,
        old_size_bytes: opts.oldStored ?? null,
      },
    ],
    rowCount: 1,
  };
}

/**
 * Deliberately equal to no wire size any test in this file writes, so a gate that
 * silently fell back to wire bytes cannot produce the same arithmetic. Small
 * enough to sit far under both byte ceilings, so it never perturbs a test that is
 * about something else.
 */
const DEFAULT_STORED_BYTES = 777;

/** An array of `n` ones: wire size `2n + 1`, stored size `3n`. */
const ones = (n: number) => Array.from({ length: n }, () => 1);

/** True for the stored-size probe statement. */
const isSizeProbe = (sql: unknown) => String(sql).includes('octet_length(');

/**
 * Default pool routing. `mockResolvedValueOnce` still takes precedence, so a test
 * that queues an explicit chain is unaffected; this only supplies a well-formed
 * probe answer to the tests that never cared about sizes.
 */
async function defaultPoolQuery(sql: string) {
  if (isSizeProbe(sql)) return sizeProbe();
  return { rows: [], rowCount: 0 };
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
  mockPool.query.mockImplementation(defaultPoolQuery);
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
      // size probe: no existing row for this key
      .mockResolvedValueOnce(sizeProbe());

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
      // size probe: no existing row for this key
      .mockResolvedValueOnce(sizeProbe());
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
      // size probe: no existing row
      .mockResolvedValueOnce(sizeProbe());

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
        .mockResolvedValueOnce(sizeProbe());
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
  const USER_CAP_BYTES = 2 * 1024 * 1024;
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
      // The stored-size probe: fresh key, so no existing row.
      if (isSizeProbe(sql)) return sizeProbe();
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
      // An existing row of 5,000 STORED bytes, shrinking to 3,000 — so the byte
      // gate is exempt and only the row gate is under test here.
      return sizeProbe({ stored: 3_000, oldStored: 5_000 });
    });
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:42' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: ones(1000) })
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

  // ── Over-cap SHRINK (a cap must never trap the account it applies to) ───────
  //
  // `userUsedBytes` is what is stored NOW, so a counter at or above the ceiling
  // made `used + netDelta > CAP` true for a SHRINK as well as a growth: the one
  // write that would bring the account back under the cap was the write refused,
  // leaving `storage.delete` — which the app has to expose an affordance for — as
  // the only exit. Not a live regression at the time of writing (the widest
  // observed per-user footprint is well under the cap), but reachable the moment
  // a cap is lowered, a counter drifts, or usage grows.
  it('lets a user ALREADY over the per-user cap shrink an existing value', async () => {
    useSubjectFromSub();
    const overCap = USER_CAP_BYTES + 512 * 1024;
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('.quota q')) {
        return {
          rows: [
            {
              used_bytes: '0',
              row_count: '0',
              user_used_bytes: String(overCap),
              user_row_count: '3',
            },
          ],
          rowCount: 1,
        };
      }
      // An existing, much larger row — so this write is a shrink IN STORED BYTES,
      // which is the unit the counter and the ceiling are both in. 500 ones
      // occupy 1,500 stored bytes against a 1,001-byte wire form, so a gate that
      // slipped back to wire bytes would be computing a different delta here.
      return sizeProbe({ stored: 1_500, oldStored: 61_440 });
    });
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:42' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: ones(500) })
    ).resolves.toMatchObject({ ok: true });
    // The write reached the transaction rather than being short-circuited.
    expect(mockPool.connect).toHaveBeenCalled();
  });

  // The boundary itself. A same-size rewrite is netDelta === 0 — it stores no new
  // bytes, so it is exactly as safe as a shrink and must be allowed. Separated
  // from the shrink case so `<= 0` narrowing to `< 0` has its own killing test
  // rather than dying to a neighbouring assertion.
  it('lets an over-cap user rewrite a value to the SAME size (netDelta === 0)', async () => {
    useSubjectFromSub();
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('.quota q')) {
        return {
          rows: [
            {
              used_bytes: '0',
              row_count: '0',
              user_used_bytes: String(USER_CAP_BYTES + 512 * 1024),
              user_row_count: '3',
            },
          ],
          rowCount: 1,
        };
      }
      // 500 ones occupy 1,500 STORED bytes — the exact stored size of the
      // replacement below, so the delta is zero rather than merely small. Stated
      // in stored bytes: the wire form is 1,001, so a wire-unit gate would see
      // this as a 499-byte shrink and pass for the wrong reason.
      return sizeProbe({ stored: 1_500, oldStored: 1_500 });
    });
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:42' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: ones(500) })
    ).resolves.toMatchObject({ ok: true });
  });

  // The other half of the same claim: relaxing the gate for a shrink must NOT
  // relax it for a growth. Same over-cap state, same existing row, a LARGER new
  // value — still refused. Without this, deleting the gate outright also passes
  // the test above.
  it('still refuses a GROWTH from the same over-cap state', async () => {
    useSubjectFromSub();
    const overCap = USER_CAP_BYTES + 512 * 1024;
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('.quota q')) {
        return {
          rows: [
            {
              used_bytes: '0',
              row_count: '0',
              user_used_bytes: String(overCap),
              user_row_count: '3',
            },
          ],
          rowCount: 1,
        };
      }
      // Same 1,500 stored bytes as the same-size case above; the write below is a
      // genuine GROWTH in stored bytes (2,500 ones = 7,500 stored).
      return sizeProbe({ stored: 7_500, oldStored: 1_500 });
    });
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:42' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: ones(2500) })
    ).rejects.toMatchObject({ message: 'per-user storage quota exceeded' });
  });

  // Same trap, app-wide ceiling. Kept as its own case because it is a different
  // gate on a different counter — the per-user test above passes with this one
  // still broken.
  //
  // 🔴 THE BREACH MUST EXCEED THE SHRINK, or the guard never executes. A first
  // draft used `APP_CAP_BYTES + 4096` against a ~60KB shrink: the write brought
  // the total back under the ceiling by arithmetic, so `used + netDelta > CAP`
  // was false either way and removing the exemption left the test GREEN. 256KB
  // over, shrinking by ~60KB, leaves the projected total still ~196KB above the
  // ceiling — so only the exemption can let it through.
  it('lets a write that shrinks the APP total through a breached app ceiling', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          {
            used_bytes: String(APP_CAP_BYTES + 256 * 1024),
            row_count: '5',
            user_used_bytes: '0',
            user_row_count: '1',
          },
        ],
        rowCount: 1,
      })
      // 61,440 stored bytes shrinking to 1,500 — a ~60KB shrink against a 256KB
      // breach, so the projected total is still ~196KB over the ceiling and only
      // the exemption can let it through.
      .mockResolvedValueOnce(sizeProbe({ stored: 1_500, oldStored: 61_440 }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: ones(500) })
    ).resolves.toMatchObject({ ok: true });
  });

  // ── The quota-exceeded counter says WHICH ceiling ───────────────────────────
  // An app-ceiling breach is rare, shared by every user of the app, and needs an
  // operator; a per-user refusal is routine and self-recoverable. They shared one
  // label set, so no query could separate "alert now" from "normal Tuesday".
  it('labels an APP-ceiling refusal ceiling=app and a per-USER refusal ceiling=user', async () => {
    const quotaInc = vi.mocked(appStorageQuotaExceededCounter.inc);
    quotaInc.mockClear();

    // App ceiling: a big enough write against a full app.
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          {
            used_bytes: String(APP_CAP_BYTES),
            row_count: '1',
            user_used_bytes: '0',
            user_row_count: '0',
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce(sizeProbe());
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: 'x'.repeat(500) })
    ).rejects.toMatchObject({ message: 'app quota exceeded' });
    expect(quotaInc).toHaveBeenCalledWith({ app_block_id: 'apb_test', ceiling: 'app' });

    // Per-user ceiling: a small write against a full user in a near-empty app.
    quotaInc.mockClear();
    useSubjectFromSub();
    mockPool.query.mockImplementation(quotaPoolFor({ 42: USER_CAP_BYTES - 10 }));
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:42' }));
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: 'x'.repeat(500) })
    ).rejects.toMatchObject({ message: 'per-user storage quota exceeded' });
    expect(quotaInc).toHaveBeenCalledWith({ app_block_id: 'apb_test', ceiling: 'user' });
  });

  // ── Deploy order: a schema that predates `user_quota` ───────────────────────
  //
  // `user_quota` is created by AppStorageProvisioner.provision, whose only
  // callers are new-version approval and the manual admin backfill — nothing
  // schedules it. A LEFT JOIN tolerates a missing ROW, not a missing RELATION, so
  // at deploy every `set` on every already-provisioned app raised 42P01 until a
  // human ran the backfill. `get`/`list`/`getQuota` were unaffected, which is
  // what made it look survivable.
  describe('a schema provisioned before user_quota existed', () => {
    /** What node-postgres raises for `undefined_table`. */
    function undefinedTable(relation: string) {
      return Object.assign(new Error(`relation "${relation}" does not exist`), {
        code: '42P01',
      });
    }

    /** Joined read raises 42P01; the un-joined fallback resolves. */
    function poolMissingUserQuota() {
      return async (sql: string) => {
        if (sql.includes('user_quota')) throw undefinedTable('app_x.user_quota');
        if (sql.includes('.quota q')) {
          return {
            rows: [
              {
                used_bytes: '4096',
                row_count: '2',
                user_used_bytes: '0',
                user_row_count: '0',
              },
            ],
            rowCount: 1,
          };
        }
        if (isSizeProbe(sql)) return sizeProbe();
        return { rows: [], rowCount: 0 };
      };
    }

    it('accepts the write instead of returning INTERNAL_SERVER_ERROR', async () => {
      mockPool.query.mockImplementation(poolMissingUserQuota());
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      const caller = appsRouter.createCaller(fakeCtx() as never);
      await expect(
        caller.storage.set({ blockToken: 't', key: 'k', value: 'v' })
      ).resolves.toMatchObject({ ok: true });
      // The row was actually written, not just a clean return.
      const insert = (mockClient.query.mock.calls as Array<[string, unknown[]?]>).find(([s]) =>
        s.includes('INSERT INTO')
      );
      expect(insert).toBeDefined();
    });

    it('falls back to a statement that reads the app counters WITHOUT the join', async () => {
      mockPool.query.mockImplementation(poolMissingUserQuota());
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      const caller = appsRouter.createCaller(fakeCtx() as never);
      await caller.storage.set({ blockToken: 't', key: 'k', value: 'v' });
      const quotaReads = (mockPool.query.mock.calls as Array<[string, unknown[]?]>)
        .map(([s]) => s)
        .filter((s) => s.includes('.quota q'));
      // Two attempts: the joined one that raised, then the fallback that did not.
      expect(quotaReads).toHaveLength(2);
      expect(quotaReads[0]).toContain('user_quota');
      expect(quotaReads[1]).not.toContain('user_quota');
    });

    it('logs the missing relation so an inert sub-quota is visible', async () => {
      mockPool.query.mockImplementation(poolMissingUserQuota());
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      const caller = appsRouter.createCaller(fakeCtx() as never);
      await caller.storage.set({ blockToken: 't', key: 'k', value: 'v' });
      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'user_quota_relation_missing', appBlockId: 'apb_test' }),
        expect.anything()
      );
    });

    // …and ALERTABLE, not only greppable. The log line alone made the inert
    // sub-quota visible to a human who went looking, which is the state
    // `countStorageFault`'s docstring argues is unacceptable for a fault: nothing
    // can be alerted on it, and nothing schedules the backfill that ends it, so
    // the app can serve unmetered indefinitely. Its own series is what closes it —
    // deliberately not an `outcome` on the ops counter, where it would be
    // invisible among ordinary successful writes.
    it('counts the untracked write on its own series, labelled by app', async () => {
      const untrackedInc = vi.mocked(appStorageUserQuotaUntrackedCounter.inc);
      untrackedInc.mockClear();
      mockPool.query.mockImplementation(poolMissingUserQuota());
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      const caller = appsRouter.createCaller(fakeCtx() as never);
      await caller.storage.set({ blockToken: 't', key: 'k', value: 'v' });
      expect(untrackedInc).toHaveBeenCalledWith({ app_block_id: 'apb_test' });
      expect(untrackedInc).toHaveBeenCalledTimes(1);
    });

    // The other half: a NORMAL write must not touch that series, or it stops
    // meaning "this app is unmetered" and an alert on it fires on every write.
    it('does NOT count the untracked series when user_quota is present', async () => {
      const untrackedInc = vi.mocked(appStorageUserQuotaUntrackedCounter.inc);
      untrackedInc.mockClear();
      useSubjectFromSub();
      mockPool.query.mockImplementation(quotaPoolFor({ 42: 0 }));
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:42' }));
      const caller = appsRouter.createCaller(fakeCtx() as never);
      await caller.storage.set({ blockToken: 't', key: 'k', value: 'v' });
      expect(untrackedInc).not.toHaveBeenCalled();
    });

    // The fallback must not swallow a genuinely broken schema: `quota` missing
    // too raises the same 42P01 from the fallback statement and propagates.
    it('still fails when the app `quota` table is missing as well', async () => {
      const inc = vi.mocked(appStorageOpsCounter.inc);
      inc.mockClear();
      mockPool.query.mockImplementation(async () => {
        throw undefinedTable('app_x.quota');
      });
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      const caller = appsRouter.createCaller(fakeCtx() as never);
      // tRPC re-wraps a non-TRPCError as INTERNAL_SERVER_ERROR on the way out, so
      // the pg code is asserted through the surviving message rather than `.code`.
      await expect(caller.storage.set({ blockToken: 't', key: 'k', value: 'v' })).rejects.toThrow(
        'relation "app_x.quota" does not exist'
      );
      // Two attempts, both raising — the fallback did not paper over it.
      expect(mockPool.query.mock.calls.filter(([s]) => String(s).includes('.quota q'))).toHaveLength(
        2
      );
      expect(inc).toHaveBeenCalledWith({ op: 'set', outcome: 'error' });
    });
  });

  // ── An unexpected fault must be COUNTABLE ──────────────────────────────────
  //
  // Only the write transaction's own catch incremented `outcome:'error'`, so any
  // fault BEFORE `BEGIN` — the quota round trip, the pool checkout, token
  // resolution — was visible solely as the `ok` series falling to zero. An
  // outage with no error series is an outage nothing can alert on.
  it("counts outcome:'error' for a fault raised before the write transaction opens", async () => {
    const inc = vi.mocked(appStorageOpsCounter.inc);
    inc.mockClear();
    mockPool.query.mockImplementation(async () => {
      throw new Error('connection terminated unexpectedly');
    });
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(caller.storage.set({ blockToken: 't', key: 'k', value: 'v' })).rejects.toThrow(
      'connection terminated unexpectedly'
    );
    expect(inc).toHaveBeenCalledWith({ op: 'set', outcome: 'error' });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  // …and must be counted exactly ONCE when it happens inside the transaction,
  // which is where it was already counted. The catch-all discriminates on the
  // error TYPE, so a double-count here would be silent.
  //
  // INVARIANT GUARD, not regression coverage: this case was green before the
  // catch-all existed too (the write transaction's own catch counted it once).
  // What it pins is that ADDING the catch-all did not turn one increment into
  // two. Its killing mutation is re-adding `appStorageOpsCounter.inc({ op:
  // 'set', outcome: 'error' })` to the inner transaction catch — measured, that
  // turns THIS test red and nothing else. Deleting the `TRPCError` early-return
  // in `countStorageFault` does NOT reach it (the fault here is a raw Error, so
  // the early-return never applies); that mutation is caught by the sibling
  // deliberate-refusal case below instead.
  it("counts outcome:'error' once, not twice, for a fault inside the write", async () => {
    const inc = vi.mocked(appStorageOpsCounter.inc);
    inc.mockClear();
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query
      .mockResolvedValueOnce({
        rows: [
          { used_bytes: '0', row_count: '0', user_used_bytes: '0', user_row_count: '0' },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce(sizeProbe());
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO')) throw new Error('deadlock detected');
      return { rows: [], rowCount: 0 };
    });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(caller.storage.set({ blockToken: 't', key: 'k', value: 'v' })).rejects.toThrow(
      'deadlock detected'
    );
    const errorIncs = inc.mock.calls.filter(
      ([labels]) => (labels as { outcome?: string })?.outcome === 'error'
    );
    expect(errorIncs).toHaveLength(1);
  });

  // A deliberate refusal already counts its own outcome. The catch-all must not
  // add a second, wrong one on top — otherwise every quota refusal would also
  // read as a fault, and `outcome:'error'` would stop meaning anything.
  //
  // INVARIANT GUARD as well (green before the catch-all, for want of a
  // catch-all). This is the case that pins `countStorageFault`'s TRPCError
  // early-return: measured, deleting that `return` turns THIS test red — and
  // only this one — because a deliberate refusal is the only path where an
  // already-counted error reaches the catch-all.
  it("does NOT count outcome:'error' for a deliberate quota refusal", async () => {
    const inc = vi.mocked(appStorageOpsCounter.inc);
    inc.mockClear();
    useSubjectFromSub();
    mockPool.query.mockImplementation(quotaPoolFor({ 42: USER_CAP_BYTES - 10 }));
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:42' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: 'x'.repeat(500) })
    ).rejects.toMatchObject({ message: 'per-user storage quota exceeded' });
    expect(inc).toHaveBeenCalledWith({ op: 'set', outcome: 'quota_exceeded' });
    expect(inc).not.toHaveBeenCalledWith({ op: 'set', outcome: 'error' });
  });

  // The refusal's own log has to be readable. `userUsedBytes` is the
  // trigger-maintained counter (stored bytes) and the gate that refused is
  // `userUsedBytes + netDelta`, so `attemptedBytes` must be in the SAME unit — a
  // wire byte count there reads as the number that was compared and is not, by up
  // to 1.5x. `quotaPoolFor` answers the probe with DEFAULT_STORED_BYTES for a
  // fresh key, which is not the wire size of the value written.
  it('logs the refusal in STORED bytes, the unit the gate actually compared', async () => {
    useSubjectFromSub();
    mockPool.query.mockImplementation(quotaPoolFor({ 42: USER_CAP_BYTES - 10 }));
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:42' }));
    const caller = appsRouter.createCaller(fakeCtx() as never);
    const value = 'x'.repeat(500);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value })
    ).rejects.toMatchObject({ message: 'per-user storage quota exceeded' });
    // The wire size and the stored size are different numbers here, which is what
    // makes the assertion able to tell them apart.
    expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).not.toBe(DEFAULT_STORED_BYTES);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'user_quota_exceeded',
        attemptedBytes: DEFAULT_STORED_BYTES,
        netDeltaBytes: DEFAULT_STORED_BYTES,
        userUsedBytes: USER_CAP_BYTES - 10,
      }),
      expect.anything()
    );
  });

  // ── The stored-size probe must FAIL LOUD, never absorb ─────────────────────
  //
  // Both byte ceilings are computed from this one row. Absorbing a missing or
  // non-numeric row into a 0 makes `netDelta` 0 or NaN, and BOTH of those sail
  // through every gate below it — 0 reads as a non-increasing write and takes the
  // exemption, NaN makes every `>` comparison false. So the failure mode of a
  // silent fallback here is not "a refused write", it is "an unmetered write",
  // which is the same class as the defect this probe exists to fix.
  //
  // Killing mutation: replacing the throw with `?? 0` turns BOTH cases below
  // green-and-wrong — the write is accepted with the gates skipped.
  it.each([
    ['no row at all', { rows: [] as unknown[], rowCount: 0 }, 'no usable row'],
    [
      'a NULL new size',
      { rows: [{ new_size_bytes: null, old_size_bytes: null }], rowCount: 1 },
      'no usable row',
    ],
    [
      'a non-numeric new size',
      { rows: [{ new_size_bytes: 'abc', old_size_bytes: null }], rowCount: 1 },
      'no usable row',
    ],
    // The old size has its own throw with its own message, so it needs its own
    // case — the two guards are not interchangeable and a shared assertion would
    // let either one cover for the other.
    [
      'a non-numeric old size',
      { rows: [{ new_size_bytes: 100, old_size_bytes: 'abc' }], rowCount: 1 },
      'a non-numeric old size',
    ],
  ])(
    'refuses the write when the stored-size probe returns %s',
    async (_label, probeResult, expectedMessage) => {
    const inc = vi.mocked(appStorageOpsCounter.inc);
    inc.mockClear();
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockImplementation(async (sql: string) => {
      if (isSizeProbe(sql)) return probeResult;
      return {
        rows: [
          { used_bytes: '0', row_count: '0', user_used_bytes: '0', user_row_count: '0' },
        ],
        rowCount: 1,
      };
    });
    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: { a: 1 } })
    ).rejects.toThrow(`app storage: stored-size probe returned ${expectedMessage}`);
    // It is a FAULT, not a refusal — so it lands on the error series an alert can
    // watch, and the write never reached the transaction.
    expect(inc).toHaveBeenCalledWith({ op: 'set', outcome: 'error' });
    expect(mockPool.connect).not.toHaveBeenCalled();
    }
  );

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
      // Both numbers in STORED bytes: an existing 5,000-byte row replaced by a
      // 300-byte one.
      .mockResolvedValueOnce(sizeProbe({ stored: 300, oldStored: 5_000 }));

    const caller = appsRouter.createCaller(fakeCtx() as never);
    await expect(
      caller.storage.set({ blockToken: 't', key: 'k', value: ones(100) })
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
      limitBytes: 2 * 1024 * 1024,
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
    expect(out.limitBytes).toBe(2 * 1024 * 1024);
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
      limitBytes: 2 * 1024 * 1024,
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
    // quota pre-read empty (under quota) + a stored-size probe for a fresh key.
    mockPool.query.mockImplementation(defaultPoolQuery);
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
