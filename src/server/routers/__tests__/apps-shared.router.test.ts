import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClientModule from '~/server/flipt/client';
import { TRPCError } from '@trpc/server';

/**
 * Coverage for `apps.shared.*` (block-token authed cross-user storage) +
 * `apps.mod.purgeSharedRow` (session moderatorProcedure). Mocks the pg pool, the
 * block-token verifier, the dedicated Flipt flag, the rate limiters, and the
 * subject hydration so each auth / counter / trust / safety gate is pinned
 * independently. The content-safety belt runs FOR REAL (real includesMinor /
 * includesPoi / HTML-escape) with only its redis-backed deps (blocklist,
 * promptAuditing) mocked — so the C3 tests exercise the genuine audit path.
 */

const {
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockDbRead,
  mockIsSharedEnabled,
  mockPool,
  mockClient,
  mockGetSessionUser,
  mockCheckAppendRl,
  mockCheckVoteRl,
  mockCheckReportRl,
  mockCheckWithdrawRl,
  mockThrowOnBlockedUserContent,
  mockAuditPromptServer,
  mockIsRevoked,
  mockLogToAxiom,
  mockSyncSubListing,
  mockIsFlipt,
  mockGetFliptBoolean,
  mockFindBlocked,
  mockChInsert,
} = vi.hoisted(() => {
  // 🔴 THE SIGNATURE IS DECLARED VIA THE GENERIC, NOT AS UNUSED PARAMETERS. `pg`'s
  // `query(sql, params)` is what the router calls, and `vi.fn(async () => …)` infers a
  // ZERO-ARG signature — so every `mockImplementation(async (sql, params) => …)` below
  // was a TS2345 under `tsconfig.tests.json` (which `pnpm typecheck` does not cover,
  // because `tsconfig.json` excludes `src/**/__tests__/**`). Declaring it here fixes
  // that class at its one source rather than at each call site.
  //
  // ⚠️ `vi.fn(async (_sql, _params) => …)` also works for the TYPE, and was the first
  // version of this — but it introduces two `no-unused-vars` warnings per site, because
  // `.eslintrc.js` sets that rule with no `argsIgnorePattern`, so the `_` prefix buys
  // nothing here. The generic carries the signature with a zero-arg body, which is the
  // same trick the behaviour suite uses on `mockIsRevoked` for the same reason.
  type QueryFn = (
    sql: string,
    params?: unknown[]
  ) => Promise<{
    rows: unknown[];
    rowCount: number;
  }>;
  // The rate limiters' real shape: `(userId, appBlockId) => { allowed, retryAfterSeconds? }`.
  // 🔴 DECLARED AT THE SOURCE, for the same reason as `QueryFn`. `vi.fn(async () => ({
  // allowed: true }))` infers BOTH a zero-arg signature AND a return type without
  // `retryAfterSeconds` — which is why forwarding two arguments was a TS2554 and every
  // `mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60 })` was a TS2353.
  // Typing the passthroughs instead of the mocks only moved the first error class
  // (TS2556 -> TS2554); the callee is where it actually lives.
  type RateLimitFn = (
    userId: number,
    appBlockId: string
  ) => Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
  const mockClient = {
    query: vi.fn<QueryFn>(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
  const mockPool = {
    connect: vi.fn(async () => mockClient),
    query: vi.fn<QueryFn>(async () => ({ rows: [], rowCount: 0 })),
  };
  return {
    mockVerifyBlockToken: vi.fn(),
    mockParseSubjectUserId: vi.fn(),
    mockDbRead: { appBlock: { findUnique: vi.fn() }, account: { count: vi.fn() } },
    mockIsSharedEnabled: vi.fn(async () => true),
    mockPool,
    mockClient,
    mockGetSessionUser: vi.fn(),
    mockCheckAppendRl: vi.fn<RateLimitFn>(async () => ({ allowed: true })),
    mockCheckVoteRl: vi.fn<RateLimitFn>(async () => ({ allowed: true })),
    mockCheckReportRl: vi.fn<RateLimitFn>(async () => ({ allowed: true })),
    mockCheckWithdrawRl: vi.fn<RateLimitFn>(async () => ({ allowed: true })),
    // Same source-level typing as `QueryFn` / `RateLimitFn` above: the signature lives on
    // the mock, so the passthroughs below can forward real arguments instead of spreading
    // an `unknown[]` into a zero-arg inference.
    // 🔴 ARITY TWO, deliberately. The real `throwOnBlockedUserContent` is
    // `(content, { isModerator, surface, onBlocked })` — blocklist.service.ts:620-628 — and
    // shared-content-safety.ts:119 calls it with both. Declaring this arity-ONE silently
    // DROPPED the options object before it reached the mock (measured: `mock.calls[0].length`
    // 2 → 1), which made `onBlocked` unreachable from this suite — i.e. the link-vs-pattern
    // distinction that shared-content-safety.ts:110-112 keeps exact could not be guarded at
    // all. No test failed, which is what made it invisible. Keep the second parameter.
    mockThrowOnBlockedUserContent: vi.fn<(content: unknown, options?: unknown) => Promise<void>>(
      async () => undefined
    ),
    mockAuditPromptServer: vi.fn<(args: unknown) => Promise<void>>(async () => undefined),
    mockIsRevoked: vi.fn<(blockInstanceId: string, sub?: string) => Promise<boolean>>(
      async () => false
    ),
    mockLogToAxiom: vi.fn<(payload: unknown, stream?: string) => Promise<void>>(
      async () => undefined
    ),
    mockSyncSubListing: vi.fn<(args: unknown) => Promise<void>>(async () => undefined),
    // `data`/counter-key moderation: the two per-app flags, the pure blocklist classifier and the
    // hit-list sink. The detectors themselves (includesMinor/includesPoi/auditPromptEnriched) run
    // for real.
    mockIsFlipt: vi.fn<(flag: string, entityId?: string, context?: unknown) => Promise<boolean>>(
      async () => false
    ),
    // `user-content-pattern-enforce`, which also governs whether a `data` pattern hit rejects.
    mockGetFliptBoolean: vi.fn<(flag: string) => Promise<boolean>>(async () => false),
    mockFindBlocked: vi.fn<(values: unknown, opts?: unknown) => Promise<unknown[]>>(async () => []),
    mockChInsert: vi.fn<(args: { table: string; values: unknown[] }) => Promise<void>>(
      async () => undefined
    ),
  };
});

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...args: unknown[]) => mockParseSubjectUserId(...args),
}));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksSharedStorageEnabled: mockIsSharedEnabled,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => mockGetSessionUser(...a) },
}));
vi.mock('~/server/db/appsDb', () => ({ requireAppsDb: () => mockPool }));
// 🔴 THE PASSTHROUGHS FORWARD EXPLICIT ARGUMENTS, not `(...a: unknown[])`. Spreading an
// `unknown[]` into a mock whose own signature `vi.fn()` inferred as zero-arg is a TS2556
// under `tsconfig.tests.json` — the same root cause as the `pg` query mocks above, in a
// second shape, and it accounted for 8 of this file's remaining type errors. Each
// forward below declares what its real callee is actually called with.
vi.mock('~/server/utils/shared-storage-rate-limit', () => ({
  checkSharedAppendRateLimit: (userId: number, appBlockId: string) =>
    mockCheckAppendRl(userId, appBlockId),
  checkSharedVoteRateLimit: (userId: number, appBlockId: string) =>
    mockCheckVoteRl(userId, appBlockId),
  checkSharedReportRateLimit: (userId: number, appBlockId: string) =>
    mockCheckReportRl(userId, appBlockId),
  checkSharedWithdrawRateLimit: (userId: number, appBlockId: string) =>
    mockCheckWithdrawRl(userId, appBlockId),
}));
// Keep the content-safety belt REAL; mock only its redis-backed deps.
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedUserContent: (content: unknown, options?: unknown) =>
    mockThrowOnBlockedUserContent(content, options),
  findBlockedUserContent: (values: unknown, opts?: unknown) => mockFindBlocked(values, opts),
  stripBenignPhrases: async (text: string) => text,
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClientModule>()),
  isFlipt: (flag: string, entityId?: string, context?: unknown) =>
    mockIsFlipt(flag, entityId, context),
  getFliptBoolean: (flag: string) => mockGetFliptBoolean(flag),
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { insert: (args: { table: string; values: unknown[] }) => mockChInsert(args) },
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: (args: unknown) => mockAuditPromptServer(args),
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: {
    isRevoked: (blockInstanceId: string, sub?: string) => mockIsRevoked(blockInstanceId, sub),
  },
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (payload: unknown, stream?: string) => mockLogToAxiom(payload, stream),
}));
// The store-item mirror is a separate service; this file pins only that the router calls it.
vi.mock('~/server/services/blocks/app-sub-listing.service', () => ({
  syncSubListingForSharedRow: (args: unknown) => mockSyncSubListing(args),
}));
// NOTE: `report` no longer fires a mod-Discord webhook — it was redundant with the
// Axiom emit below, so it and its reporter-free-text hardening (`sanitizeDiscordText`)
// are gone. Nothing else renders the reporter's `reason`: it is stored raw in the
// `shared_kv_reports` row and logged raw as a structured Axiom field, and its length is
// bounded by the input schema (`z.string().max(500)`), not by that helper. What this op
// still owes is the row plus the Axiom emit, and both are asserted below.

import {
  appendSharedRow,
  appsModRouter,
  appsSharedRouter,
  reportSharedRow,
  unvoteSharedRow,
  updateSharedRow,
  voteSharedRow,
  withdrawSharedRow,
} from '../apps-shared.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';
import { isEscalatedServerFault } from '~/server/logging/server-fault-override';

const READ = 'apps:storage:shared:read';
const WRITE = 'apps:storage:shared:write';

function validClaims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'jti_test',
    blockId: 'app-voting',
    appId: 'app_test',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_inst',
    ctx: {},
    scopes: [READ, WRITE],
    ...over,
  };
}

// A subject that PASSES the min-trust gate (H3): verified, onboarded, >7d old.
function trustedUser(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    isModerator: false,
    bannedAt: null,
    muted: false,
    onboarding: OnboardingSteps.Buzz, // Flags.hasFlag(Buzz, Buzz) === true
    emailVerified: new Date('2020-01-01'),
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    ...over,
  };
}

function fakeCtx(user?: unknown) {
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
const caller = () => appsSharedRouter.createCaller(fakeCtx() as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockIsSharedEnabled.mockImplementation(async () => true);
  mockParseSubjectUserId.mockImplementation((sub: string) =>
    sub === 'anon' ? null : Number(sub.split(':')[1])
  );
  mockGetSessionUser.mockResolvedValue(trustedUser());
  mockDbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_test', status: 'approved' });
  // Default: no linked OAuth account (so an unverified-email subject is still denied
  // unless a test opts into a linked account). Only consulted when emailVerified is
  // absent — the verified-email tests never hit this.
  mockDbRead.account.count.mockResolvedValue(0);
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mockCheckAppendRl.mockResolvedValue({ allowed: true });
  mockCheckVoteRl.mockResolvedValue({ allowed: true });
  mockCheckReportRl.mockResolvedValue({ allowed: true });
  mockCheckWithdrawRl.mockResolvedValue({ allowed: true });
  mockThrowOnBlockedUserContent.mockResolvedValue(undefined);
  mockAuditPromptServer.mockResolvedValue(undefined);
  mockLogToAxiom.mockResolvedValue(undefined);
  mockIsFlipt.mockResolvedValue(false);
  mockGetFliptBoolean.mockResolvedValue(false);
  mockFindBlocked.mockResolvedValue([]);
  mockChInsert.mockResolvedValue(undefined);
});

/**
 * Stand in for the `stored_size_bytes` column the quota SELECT projects — the
 * `octet_length(value::text)` Postgres would store for the value about to be
 * written, which is the unit `quota.used_bytes` is accounted in.
 *
 * 🔴 DELIBERATELY NOT THE WIRE SIZE, so the two units are DISTINGUISHABLE here. `2n + 1`
 * is not jsonb's real expansion — that identity is asserted against a real server in
 * `src/server/routers/__tests__/apps-shared.router.quota.stored-units.behavior.test.ts`.
 *
 * ⚠️ WHAT THIS DOES NOT BUY, measured rather than assumed. An earlier draft of this
 * comment claimed the choice means "a wire-unit term cannot satisfy a stored-unit
 * expectation by coincidence" in this suite. It does not, and the margins are why:
 * every quota case here leaves thousands of bytes between the value size and the
 * remaining budget, so `n` and `2n + 1` land on the same verdict. Measured against this
 * file as it stood before the NULL-probe test below was added, restoring the wire term
 * on EITHER write path left it **146/146 green**. The unit question is settled by the
 * behaviour suite named above, NOT here.
 *
 * What `2n + 1` DOES buy is that a case added later with a margin BETWEEN `n` and
 * `2n + 1` would discriminate, and — unintentionally but usefully — that reading
 * `params[1]` makes this suite sensitive to the two SQL parameters being swapped, which
 * it previously could not see.
 *
 * ⚠️ TWO NARROWER GUARDS DO EXIST in this file, and they are worth stating exactly
 * because the shape is easy to over- and under-read. Measured, per mutant:
 *
 *   - dropping the `requireStoredSize` CALL takes exactly one test red (the NULL-probe
 *     test), on EITHER write path;
 *   - a wire-unit term reintroduced while the now-dead probe call is LEFT IN PLACE takes
 *     exactly one test red on the APPEND path (the counter test, via its exactly-on-the-
 *     cap arm, which overrides `stored_size_bytes` and so is blind to a gate that reads
 *     the wire size) — and leaves this file FULLY GREEN on the UPDATE path.
 *
 * So: the probe CALL is defended on both paths; a wire-unit TERM is caught on append and
 * not on update. The unit as such is still only fully observable in the behaviour suite.
 *
 * (Stated as per-mutant red counts rather than as `n/total`: three successive revisions
 * of this paragraph were wrong. Two carried a total the same commit had invalidated by
 * adding tests here — a ratio rots on every added test. The third replaced the ratio with
 * "fully green on both paths", which the SAME commit falsified by adding the arm that
 * catches the append case: the proposition rotted where the ratio had. Name the mutant
 * and the path, and the claim can only rot if the code changes.)
 *
 * `$2` is the serialized value on both write paths (`$1` is the app block id).
 */
function fixtureStoredSize(params?: unknown[]) {
  return Buffer.byteLength(String((params ?? [])[1] ?? ''), 'utf8') * 2 + 1;
}

// Helper: the append data path needs the row-count + quota SELECTs to resolve so a
// trusted write reaches the INSERT.
function mockAppendDataPath() {
  mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('author_user_id') && sql.includes('count(*)'))
      return { rows: [{ n: '0' }], rowCount: 1 };
    if (sql.includes('.quota'))
      return {
        rows: [{ used_bytes: '0', row_count: '0', stored_size_bytes: fixtureStoredSize(params) }],
        rowCount: 1,
      };
    return { rows: [], rowCount: 0 };
  });
}

describe('resolver gates', () => {
  it('rejects an invalid token (UNAUTHORIZED)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(null);
    await expect(caller().getCount({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects a missing AppBlock (NOT_FOUND)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockDbRead.appBlock.findUnique.mockResolvedValueOnce(null);
    await expect(caller().getCount({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects a non-approved AppBlock (FORBIDDEN)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockDbRead.appBlock.findUnique.mockResolvedValueOnce({ id: 'apb_x', status: 'pending' });
    await expect(caller().getCount({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('rejects a revoked block instance (FORBIDDEN) — audit M-1', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockIsRevoked.mockResolvedValueOnce(true);
    await expect(caller().getCount({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('rejects a token missing the read scope (FORBIDDEN)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ scopes: [WRITE] }));
    await expect(caller().getCount({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('rejects a token missing the write scope on append (FORBIDDEN)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ scopes: [READ] }));
    await expect(
      caller().append({ blockToken: 't', value: { title: 'hi' } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('FLAG DARK → every op refuses (FORBIDDEN)', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims());
    mockIsSharedEnabled.mockResolvedValue(false);
    await expect(caller().list({ blockToken: 't' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller().append({ blockToken: 't', value: { title: 'hi' } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('H3 min-trust gate (write + vote)', () => {
  const cases: Array<[string, Record<string, unknown> | null]> = [
    ['vanished subject (null)', null],
    ['muted', { muted: true }],
    ['banned', { bannedAt: new Date() }],
    ['unverified email', { emailVerified: undefined }],
    ['onboarding incomplete', { onboarding: 0 }],
    ['too-new account', { createdAt: new Date() }],
  ];
  for (const [name, over] of cases) {
    it(`DENIES an untrusted writer: ${name} (FORBIDDEN)`, async () => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      mockGetSessionUser.mockResolvedValueOnce(over === null ? null : trustedUser(over));
      await expect(
        caller().append({ blockToken: 't', value: { title: 'idea' } })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockPool.connect).not.toHaveBeenCalled();
    });
  }

  it('ALLOWS a trusted writer (reaches the data path)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('author_user_id') && sql.includes('count(*)'))
        return { rows: [{ n: '0' }], rowCount: 1 };
      if (sql.includes('.quota'))
        return {
          rows: [{ used_bytes: '0', row_count: '0', stored_size_bytes: fixtureStoredSize(params) }],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    });
    const out = await caller().append({ blockToken: 't', value: { title: 'idea' } });
    expect(out.key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(mockPool.connect).toHaveBeenCalled();
  });

  it('anon may READ list/counts', async () => {
    mockVerifyBlockToken.mockResolvedValue(validClaims({ sub: 'anon' }));
    const out = await caller().list({ blockToken: 't' });
    expect(out.items).toEqual([]);
  });

  it('🔴 a VANISHED subject is refused on a READ even with the flag base-`enabled: true`', async () => {
    // The READ ops have no second belt: `append`/`vote` catch a vanished subject on
    // the min-trust gate above, `list`/`get` never reach it, so the shared-storage
    // flag was the only thing standing there — and its no-user branch is a GLOBAL
    // eval, which returns the flag's BASE value rather than a guaranteed `false`.
    // `mockIsSharedEnabled` is forced TRUE here to model the GA base flip; before the
    // fix, `list` resolved and served shared rows to a token whose subject is gone.
    mockVerifyBlockToken.mockResolvedValue(validClaims({ sub: 'user:999' }));
    mockGetSessionUser.mockResolvedValue(null);
    mockIsSharedEnabled.mockResolvedValue(true);
    await expect(caller().list({ blockToken: 't' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'token subject could not be resolved',
    });
    await expect(caller().get({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'token subject could not be resolved',
    });
  });

  it('POSITIVE CONTROL: an ANON token still READS under the same base-true flag', async () => {
    // The anon path must NOT be swept up by the refusal above — `sub:'anon'` has no
    // subject to vanish, and a global eval of a base-enabled flag is precisely the
    // intended GA widening. Without this, the previous test is indistinguishable from
    // a change that simply closed shared reads.
    mockVerifyBlockToken.mockResolvedValue(validClaims({ sub: 'anon' }));
    mockGetSessionUser.mockResolvedValue(null);
    mockIsSharedEnabled.mockResolvedValue(true);
    const out = await caller().list({ blockToken: 't' });
    expect(out.items).toEqual([]);
  });

  it('anon NEVER writes (UNAUTHORIZED)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' }));
    await expect(caller().append({ blockToken: 't', value: { title: 'x' } })).rejects.toMatchObject(
      { code: 'UNAUTHORIZED' }
    );
    await expect(caller().vote({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

// "Verified email" is satisfied by emailVerified OR a linked OAuth account. civitai
// only sets emailVerified via the email-CHANGE flow — OAuth sign-in never does — so
// ~69% of active (OAuth-heavy) users had emailVerified=NULL and were wrongly locked
// out. A linked OAuth account is a provider-verified identity (a STRONGER anti-sybil
// signal than an unverified civitai email), so it now satisfies the gate. The other
// trust conditions (banned/muted/onboarding/age/tier) are UNCHANGED and still take
// precedence in the SAME order.
describe('OAuth-linked account satisfies the verified-email trust condition', () => {
  it('(case 2 — THE FIX) emailVerified NULL + hasLinkedOAuth=true → PASSES', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetSessionUser.mockResolvedValueOnce(trustedUser({ emailVerified: undefined }));
    mockDbRead.account.count.mockResolvedValueOnce(1); // one linked OAuth account
    mockAppendDataPath();
    const out = await caller().append({ blockToken: 't', value: { title: 'idea' } });
    expect(out.key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(mockPool.connect).toHaveBeenCalled();
    // the account query keyed on the SUBJECT userId (from the verified token), not input
    expect(mockDbRead.account.count).toHaveBeenCalledWith({ where: { userId: 42 } });
  });

  it('(case 3) emailVerified NULL + hasLinkedOAuth=false → DENIED (Verify your email…)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetSessionUser.mockResolvedValueOnce(trustedUser({ emailVerified: undefined }));
    mockDbRead.account.count.mockResolvedValueOnce(0); // no linked OAuth account
    await expect(
      caller().append({ blockToken: 't', value: { title: 'idea' } })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Verify your email before contributing',
    });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('(case 1 — unchanged) emailVerified set → PASSES WITHOUT querying account.count', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    // trustedUser() default has emailVerified set
    mockAppendDataPath();
    const out = await caller().append({ blockToken: 't', value: { title: 'idea' } });
    expect(out.key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // query-only-when-needed: a verified-email subject incurs NO account query
    expect(mockDbRead.account.count).not.toHaveBeenCalled();
  });

  it('(query-only-when-needed) unverified subject DOES query account.count', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetSessionUser.mockResolvedValueOnce(trustedUser({ emailVerified: undefined }));
    mockDbRead.account.count.mockResolvedValueOnce(1);
    mockAppendDataPath();
    await caller().append({ blockToken: 't', value: { title: 'idea' } });
    expect(mockDbRead.account.count).toHaveBeenCalledTimes(1);
    expect(mockDbRead.account.count).toHaveBeenCalledWith({ where: { userId: 42 } });
  });

  // (case 4) the OTHER trust conditions still DENY with their specific messages and
  // take PRECEDENCE — even when hasLinkedOAuth would be true, the earlier check wins.
  // These fire BEFORE the email/OAuth check, so account.count is never consulted.
  const precedence: Array<[string, Record<string, unknown>, string]> = [
    ['banned', { bannedAt: new Date() }, 'Your account is not eligible for this action'],
    ['muted', { muted: true }, 'Your account has been restricted'],
    ['onboarding incomplete', { onboarding: 0 }, 'Complete onboarding before contributing'],
    ['too-new account', { createdAt: new Date() }, 'Your account is too new to contribute'],
  ];
  for (const [name, over, message] of precedence) {
    it(`(case 4) ${name} still DENIES (precedence preserved) even with a linked OAuth account`, async () => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      // emailVerified absent AND a linked OAuth account present — proves the earlier
      // condition, not the email/OAuth check, is what denies.
      mockGetSessionUser.mockResolvedValueOnce(trustedUser({ ...over, emailVerified: undefined }));
      mockDbRead.account.count.mockResolvedValue(1);
      await expect(
        caller().append({ blockToken: 't', value: { title: 'idea' } })
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message });
      expect(mockPool.connect).not.toHaveBeenCalled();
    });
  }

  // Precedence proof for a subject whose email IS verified: banned still denies and
  // — because emailVerified is present — the account.count query is skipped entirely
  // (banned wins before the email/OAuth branch is ever relevant).
  it('(case 4) a verified-email banned subject denies WITHOUT an account query', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetSessionUser.mockResolvedValueOnce(trustedUser({ bannedAt: new Date() }));
    await expect(
      caller().append({ blockToken: 't', value: { title: 'idea' } })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Your account is not eligible for this action',
    });
    expect(mockDbRead.account.count).not.toHaveBeenCalled();
    expect(mockPool.connect).not.toHaveBeenCalled();
  });
});

// Defense-in-depth for the CONSENT_EXEMPT change (shared scopes now sign into
// tokens without a per-user consent grant, so an anon/low-trust token can now
// legitimately CARRY apps:storage:shared:write). These pin that the trust gate
// is enforced INDEPENDENTLY of the scope: even with the write scope present on
// the claims, an anon / too-new / unverified subject is rejected BEFORE any data
// access. `validClaims()` already carries [READ, WRITE], so every claim here has
// the write scope present.
describe('trust gate is independent of the (now-exempt) shared:write scope', () => {
  it('anon subject with the write scope present → UNAUTHORIZED, no DB access', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' })); // scopes include WRITE
    await expect(caller().append({ blockToken: 't', value: { title: 'x' } })).rejects.toMatchObject(
      { code: 'UNAUTHORIZED' }
    );
    expect(mockPool.connect).not.toHaveBeenCalled();
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  const ineligible: Array<[string, Record<string, unknown>]> = [
    ['banned', { bannedAt: new Date() }],
    ['muted', { muted: true }],
    ['too-new account', { createdAt: new Date() }],
    ['unverified email', { emailVerified: undefined }],
    ['onboarding incomplete', { onboarding: 0 }],
  ];
  for (const [name, over] of ineligible) {
    it(`authenticated but ineligible (${name}) with the write scope present → FORBIDDEN, no DB access`, async () => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims()); // sub: user:42, scopes include WRITE
      mockGetSessionUser.mockResolvedValueOnce(trustedUser(over));
      await expect(caller().vote({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(mockPool.query).not.toHaveBeenCalled();
    });
  }

  it('a trusted subject with the scope present is allowed (reaches the vote CTE)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.trim().startsWith('SELECT 1')) return { rows: [{ x: 1 }], rowCount: 1 };
      if (sql.includes('WITH ins AS')) return { rows: [{ count: '1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const out = await caller().vote({ blockToken: 't', key: 'req1' });
    expect(out.count).toBe(1);
  });
});

describe('C1 cross-user overwrite', () => {
  it('append SERVER-generates the key (client key never used)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('author_user_id') && sql.includes('count(*)'))
        return { rows: [{ n: '0' }], rowCount: 1 };
      if (sql.includes('.quota'))
        return {
          rows: [{ used_bytes: '0', row_count: '0', stored_size_bytes: fixtureStoredSize(params) }],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    });
    // Even if a caller smuggles `key`, zod strips it and the server ULID is used.
    const out = await caller().append({
      blockToken: 't',
      value: { title: 'idea' },
      key: 'victim-key',
    } as never);
    const insert = (mockClient.query.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      c[0].includes('INSERT INTO "app_app_voting".shared_kv')
    );
    expect(insert).toBeTruthy();
    expect((insert![1] as unknown[])[0]).toBe(out.key); // param[0] is the server ULID
    expect((insert![1] as unknown[])[0]).not.toBe('victim-key');
  });

  it('withdraw only deletes the author’s OWN row (WHERE author_user_id)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DELETE')) return { rows: [], rowCount: 0 }; // not the author → 0
      return { rows: [], rowCount: 0 };
    });
    const out = await caller().withdraw({ blockToken: 't', key: 'someone-elses-key' });
    expect(out.deleted).toBe(false);
    const del = (mockClient.query.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      c[0].startsWith('DELETE')
    );
    expect(del![0]).toContain('author_user_id = $2');
    expect((del![1] as unknown[])[1]).toBe(42);
  });
});

describe('H1/H2 vote counter integrity (SQL shape + FK)', () => {
  it('vote is FK/visibility-gated and uses the insert-gated counter CTE', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('hidden_at IS NULL') && sql.trim().startsWith('SELECT 1'))
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (sql.includes('WITH ins AS')) return { rows: [{ count: '1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const out = await caller().vote({ blockToken: 't', key: 'req1' });
    expect(out.count).toBe(1);
    const cte = (mockPool.query.mock.calls as Array<[string]>).find((c) =>
      c[0].includes('WITH ins AS')
    );
    // insert-gated increment (H1): ON CONFLICT DO NOTHING + count + EXCLUDED.count
    expect(cte![0]).toContain('ON CONFLICT (key, user_id) DO NOTHING');
    expect(cte![0]).toContain('EXCLUDED.count');
  });

  it('H2: vote on a missing/hidden request rejects NOT_FOUND (pre-check)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 }); // pre-check finds nothing
    await expect(caller().vote({ blockToken: 't', key: 'ghost' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('H2: FK violation (23503) surfaces NOT_FOUND', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.trim().startsWith('SELECT 1')) return { rows: [{ x: 1 }], rowCount: 1 };
      if (sql.includes('WITH ins AS')) throw { code: '23503' };
      return { rows: [], rowCount: 0 };
    });
    await expect(caller().vote({ blockToken: 't', key: 'race' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('unvote decrements by exactly the rows deleted (symmetric CTE)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH del AS')) return { rows: [{ count: '0' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const out = await caller().unvote({ blockToken: 't', key: 'req1' });
    expect(out.count).toBe(0);
    const cte = (mockPool.query.mock.calls as Array<[string]>).find((c) =>
      c[0].includes('WITH del AS')
    );
    expect(cte![0]).toContain('count - (SELECT count(*) FROM del)');
  });
});

describe('C3 content safety (blocking on append)', () => {
  it('rejects minor content + files a Report', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    await expect(
      caller().append({ blockToken: 't', value: { title: '13 year old girl' } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // a shared_kv_reports row was filed (auto:minor)
    const report = (mockPool.query.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      c[0].includes('shared_kv_reports')
    );
    expect(report).toBeTruthy();
    expect(String((report![1] as unknown[])[3])).toContain('auto:');
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('rejects a blocked link domain (BAD_REQUEST)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockThrowOnBlockedUserContent.mockRejectedValueOnce(new Error('invalid urls'));
    await expect(
      caller().append({ blockToken: 't', value: { title: 'visit http://bad.example' } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // 🔴 PINS THE MOCK'S ARITY, because narrowing it is silent. The passthrough above once
    // declared this callee arity-ONE, which dropped the options object before it reached the
    // mock — `mock.calls[0].length` went 2 → 1 — and NO test failed, so `onBlocked` (the
    // link-vs-pattern discriminator that shared-content-safety.ts:110-112 keeps exact) became
    // unguardable. Watched red at the one-arg passthrough: `expected 1 to be 2`, 1 failed /
    // 148 passed. Assert the KEYS too, not just the count: a second positional argument of the
    // wrong shape would satisfy a bare length check.
    expect(mockThrowOnBlockedUserContent.mock.calls[0]?.length).toBe(2);
    expect(Object.keys((mockThrowOnBlockedUserContent.mock.calls[0]?.[1] ?? {}) as object)).toEqual(
      expect.arrayContaining(['isModerator', 'surface', 'onBlocked'])
    );
  });

  // FIX 2: escape-at-rest removed — text is stored RAW. XSS is contained at the
  // text-render + opaque-origin-sandbox layers (all approved apps are `unverified`
  // → no `allow-same-origin`), never by escaping the stored form. This test pins
  // that the raw bytes round-trip un-escaped so the display bug (`Tom &amp; Jerry`)
  // is gone.
  it('FIX 2: title/body are stored RAW (un-escaped)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAppendDataPath();
    await caller().append({
      blockToken: 't',
      value: { title: `Tom & Jerry <3 "x" 'y'`, body: 'a & b <span>' },
    });
    const insert = (mockClient.query.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      c[0].includes('INSERT INTO "app_app_voting".shared_kv')
    );
    const stored = String((insert![1] as unknown[])[2]);
    const parsed = JSON.parse(stored) as { title: string; body?: string };
    // RAW round-trip — the exact bytes the user typed, no HTML entities introduced.
    expect(parsed.title).toBe(`Tom & Jerry <3 "x" 'y'`);
    expect(parsed.body).toBe('a & b <span>');
    expect(stored).not.toContain('&amp;');
    expect(stored).not.toContain('&lt;');
    expect(stored).not.toContain('&#x27;');
    expect(stored).not.toContain('&quot;');
  });

  // FIX 2 guard: removing escape-at-rest must NOT weaken any OTHER control — the raw
  // text still runs the full block (minor/POI/link/audit/size).
  it('FIX 2: other safety controls STILL reject the raw text', async () => {
    // minor
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    await expect(
      caller().append({ blockToken: 't', value: { title: '13 year old girl' } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // blocked link
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockThrowOnBlockedUserContent.mockRejectedValueOnce(new Error('invalid urls'));
    await expect(
      caller().append({ blockToken: 't', value: { title: 'visit http://bad.example' } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // audit / auto-mute
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAuditPromptServer.mockRejectedValueOnce(new Error('Your prompt was flagged'));
    await expect(
      caller().append({ blockToken: 't', value: { title: 'flagged text' } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // oversized title (> SHARED_TITLE_MAX 200) — the zod input schema rejects this
    // at the procedure boundary BEFORE the handler runs, so verifyBlockToken is
    // never called (no mock queued on purpose — queuing one would leak an unconsumed
    // `mockResolvedValueOnce` into the next test).
    await expect(
      caller().append({ blockToken: 't', value: { title: 'x'.repeat(201) } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('audit rejection (auto-mute path) surfaces BAD_REQUEST', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAuditPromptServer.mockRejectedValueOnce(new Error('Your prompt was flagged'));
    await expect(
      caller().append({ blockToken: 't', value: { title: 'flagged text' } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

// FIX 1 — make shared-storage abuse OBSERVABLE (pre-GA gate 1). Every alert emit is
// fire-and-forget (`.catch`) and carries METADATA ONLY, never the content text.
describe('FIX 1 abuse observability (alert emits)', () => {
  // Pull the payloads sent on the 'block-audit' channel by name.
  function auditEmits(name: string) {
    return (mockLogToAxiom.mock.calls as Array<[Record<string, unknown>, string?]>)
      .filter((c) => c[1] === 'block-audit' && c[0]?.name === name)
      .map((c) => c[0]);
  }

  it('an audit-category block emits the SEPARATE content-block warning (not legal-block)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAuditPromptServer.mockRejectedValueOnce(new Error('Your prompt was flagged'));
    await expect(
      caller().append({ blockToken: 't', value: { title: 'harassment text' } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // audit → the lower-urgency content-block/warning event …
    const contentEmits = auditEmits('app-blocks-shared-storage-content-block');
    expect(contentEmits).toHaveLength(1);
    // slug is the SANITIZED schema slug (matches the legal-block emit shape).
    // EXACT payload: the consequence helper is shared with `data` moderation, and its `field` key
    // must never leak onto a title/body alert.
    expect(contentEmits[0]).toEqual({
      name: 'app-blocks-shared-storage-content-block',
      type: 'warning',
      category: 'audit',
      userId: 42,
      slug: 'app_voting',
      appBlockId: 'apb_test',
    });
    // metadata only — no content text leaked
    expect(JSON.stringify(contentEmits[0])).not.toContain('harassment');
    // … and it must NOT dilute the legal-urgency (CSAM/minor) channel.
    expect(auditEmits('app-blocks-shared-storage-legal-block')).toHaveLength(0);
  });

  it('minor content STILL emits the legal-block error (NOT the content-block event)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    await expect(
      caller().append({ blockToken: 't', value: { title: '13 year old girl' } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const emits = auditEmits('app-blocks-shared-storage-legal-block');
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({ type: 'error', category: 'minor' });
    expect(JSON.stringify(emits[0])).not.toContain('13 year old');
    // legal signal stays isolated from the general content-block channel.
    expect(auditEmits('app-blocks-shared-storage-content-block')).toHaveLength(0);
  });

  it('a successful append emits NO block alert', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAppendDataPath();
    await caller().append({ blockToken: 't', value: { title: 'a fine idea' } });
    expect(auditEmits('app-blocks-shared-storage-legal-block')).toHaveLength(0);
    expect(auditEmits('app-blocks-shared-storage-content-block')).toHaveLength(0);
  });

  it('a USER report emits a report alert with metadata only (NO content)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValue({ rows: [{ x: 1 }], rowCount: 1 }); // row exists
    const out = await caller().report({
      blockToken: 't',
      key: 'req-123',
      reason: 'spam and harassment',
    });
    expect(out).toEqual({ ok: true });
    const emits = auditEmits('app-blocks-shared-storage-report');
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({
      name: 'app-blocks-shared-storage-report',
      userId: 42,
      slug: 'app_voting', // sanitized schema slug
      appBlockId: 'apb_test',
      reason: 'spam and harassment',
      key: 'req-123',
    });
    // the payload carries the reporter's reason + key, but never the reported
    // ROW CONTENT (the op only holds the key).
    const report = (mockPool.query.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      c[0].includes('shared_kv_reports')
    );
    expect(report).toBeTruthy();
  });

  it('report emit is FIRE-AND-FORGET: op still succeeds if the alert throws', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValue({ rows: [{ x: 1 }], rowCount: 1 });
    mockLogToAxiom.mockRejectedValueOnce(new Error('axiom down'));
    const out = await caller().report({ blockToken: 't', key: 'req-9' });
    expect(out).toEqual({ ok: true }); // the throwing emit did not fail the report
  });

  it('block-audit emit is FIRE-AND-FORGET: op still FAILS correctly if the alert throws', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockLogToAxiom.mockRejectedValueOnce(new Error('axiom down'));
    // minor content → BAD_REQUEST regardless of the emit throwing
    await expect(
      caller().append({ blockToken: 't', value: { title: '13 year old girl' } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('a report on a missing row NEVER emits (NOT_FOUND before the alert)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 }); // row does not exist
    await expect(caller().report({ blockToken: 't', key: 'ghost' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(auditEmits('app-blocks-shared-storage-report')).toHaveLength(0);
  });
});

describe('H4 rate limits', () => {
  it('append over the daily cap → TOO_MANY_REQUESTS', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockCheckAppendRl.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60 });
    await expect(
      caller().append({ blockToken: 't', value: { title: 'idea' } })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('vote over the per-minute cap → TOO_MANY_REQUESTS', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockCheckVoteRl.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 });
    await expect(caller().vote({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });

  // `withdraw` was the ONE write op on this surface with NO bucket at all. These
  // pin the fix from the three directions that can each be wrong independently:
  // that it refuses over the cap, that it refuses BEFORE taking a connection, and
  // — the one a bare "it 429s" test would not catch — that it spends its OWN
  // bucket. Without the last, wiring it to the append or vote limiter would pass
  // the first two while silently coupling a user's ability to delete their own
  // rows to their submitting or voting budget.
  it('withdraw over the per-minute cap → TOO_MANY_REQUESTS (before any DB work)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockCheckWithdrawRl.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 17 });
    await expect(caller().withdraw({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      // 17 is pairwise-distinct from every other retryAfter in this file, so a
      // handler that echoed a sibling bucket's value (or a constant) fails here.
      message: 'Too many withdrawals — retry in 17s',
    });
    // Refused before a pooled connection is taken — the point of placing the
    // limiter ahead of the transaction rather than inside it.
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('withdraw spends its OWN bucket — not the append or vote one', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    await caller().withdraw({ blockToken: 't', key: 'k' });
    // Keyed on (subject user, appBlockId) exactly like every sibling bucket.
    expect(mockCheckWithdrawRl).toHaveBeenCalledWith(42, 'apb_test');
    expect(mockCheckAppendRl).not.toHaveBeenCalled();
    expect(mockCheckVoteRl).not.toHaveBeenCalled();
  });

  it('withdraw under the cap proceeds to the DELETE', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockClient.query.mockImplementation(async (sql: string) =>
      sql.startsWith('DELETE') ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 0 }
    );
    const out = await caller().withdraw({ blockToken: 't', key: 'k' });
    expect(out).toEqual({ ok: true, deleted: true });
    expect(mockCheckWithdrawRl).toHaveBeenCalledTimes(1);
  });
});

// F1 (pre-GA): `report` is now block-reachable and each report files a row + fires
// a mod-channel webhook, so — like every other shared write op — it MUST be
// rate-limited, AND a repeat report of the same row by the same reporter must be a
// no-op (no 2nd row, no 2nd alert, no 2nd webhook). The Discord webhook is
// co-gated with the Axiom report emit in the SAME `if (!filed) return` branch, so
// the emit count is the faithful observable for "was the mod-notify fired".
describe('F1 report rate-limit + per-(reporter,key) dedup', () => {
  function auditEmits(name: string) {
    return (mockLogToAxiom.mock.calls as Array<[Record<string, unknown>, string?]>)
      .filter((c) => c[1] === 'block-audit' && c[0]?.name === name)
      .map((c) => c[0]);
  }
  // The row-exists SELECT (on shared_kv) resolves truthy; the dedup INSERT (on
  // shared_kv_reports) resolves with the caller-supplied rowCount so we can pin
  // "new" (1) vs "duplicate" (0) independently of the existence check.
  function mockReportPath(insertRowCount: number) {
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('shared_kv_reports')) return { rows: [], rowCount: insertRowCount };
      return { rows: [{ x: 1 }], rowCount: 1 }; // the row-exists pre-check
    });
  }

  it('report over the daily cap → TOO_MANY_REQUESTS (before any DB write)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockCheckReportRl.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 3600 });
    await expect(
      caller().report({ blockToken: 't', key: 'req-1', reason: 'spam' })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    // Rate-limited before it touches the DB or emits.
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(auditEmits('app-blocks-shared-storage-report')).toHaveLength(0);
  });

  it('a NEW (reporter,key) report files exactly one row + emits once', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockReportPath(1); // insert affected a row → genuinely new
    const out = await caller().report({ blockToken: 't', key: 'req-new', reason: 'harassment' });
    expect(out).toEqual({ ok: true });
    // exactly one dedup-INSERT against shared_kv_reports, and it is a WHERE NOT
    // EXISTS conditional insert (the structural dedup) — not an unconditional VALUES.
    const inserts = (mockPool.query.mock.calls as Array<[string, unknown[]?]>).filter(
      (c) => c[0].includes('INSERT INTO') && c[0].includes('shared_kv_reports')
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toMatch(/WHERE NOT EXISTS/i);
    // the alert (and its co-gated Discord notify) fired exactly once
    expect(auditEmits('app-blocks-shared-storage-report')).toHaveLength(1);
  });

  it('a DUPLICATE (reporter,key) report is a no-op: no 2nd row, no 2nd webhook/emit', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockReportPath(0); // WHERE NOT EXISTS matched an existing row → nothing inserted
    const out = await caller().report({ blockToken: 't', key: 'req-dup', reason: 'again' });
    // still succeeds (idempotent from the caller's view) …
    expect(out).toEqual({ ok: true });
    // … but the report alert + its co-gated mod-Discord notify are SKIPPED.
    expect(auditEmits('app-blocks-shared-storage-report')).toHaveLength(0);
  });

  it('distinct keys from the same reporter each file + emit (dedup is per-key)', async () => {
    // Two distinct keys → the WHERE NOT EXISTS admits both (rowCount 1 each).
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockReportPath(1);
    await caller().report({ blockToken: 't', key: 'k1' });
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    await caller().report({ blockToken: 't', key: 'k2' });
    expect(auditEmits('app-blocks-shared-storage-report')).toHaveLength(2);
  });
});

describe('isolation + read invariants', () => {
  it('list reads shared_kv/counters + a viewer-scoped votes join (never the per-user kv), excludes hidden', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await caller().list({ blockToken: 't' });
    const sql = (mockPool.query.mock.calls[0] as [string])[0];
    expect(sql).toContain('.shared_kv');
    expect(sql).toContain('.counters');
    expect(sql).toContain('hidden_at IS NULL');
    // NEVER the per-user kv table.
    expect(sql).not.toMatch(/\.kv\b/);
    // item 3: votes IS joined now — but ONLY the viewer's own row (v.user_id = the
    // resolved subject uid) to derive the boolean; the raw vote rows are never
    // SELECTed/returned (only the derived `viewer_voted`).
    expect(sql).toMatch(
      /LEFT JOIN\s+"app_app_voting"\.votes v ON v\.key = s\.key AND v\.user_id = \$4/
    );
    expect(sql).toContain('(v.user_id IS NOT NULL) AS viewer_voted');
  });

  it('per-app isolation: schema derives from claims.blockId (app A ≠ app B)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ blockId: 'app-beta' }));
    await caller().list({ blockToken: 't' });
    const sql = (mockPool.query.mock.calls[0] as [string])[0];
    expect(sql).toContain('"app_app_beta".shared_kv');
    expect(sql).not.toContain('app_app_voting');
  });
});

// Item 3 — per-viewer vote hydration on `list`. A LEFT JOIN on the viewer's OWN
// vote row derives an additive `viewerVoted` boolean; anon → NULL uid → false.
// The raw vote rows are never returned, only the derived boolean.
describe('item 3 viewerVoted (per-viewer vote flag on list)', () => {
  it('JOINs votes on the RESOLVED subject uid and maps viewer_voted → viewerVoted', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims()); // sub user:42
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          key: 'K1',
          author_user_id: 7,
          value: { title: 't' },
          count: '2',
          created_at: new Date(),
          updated_at: new Date(),
          viewer_voted: true,
        },
        {
          key: 'K2',
          author_user_id: 8,
          value: { title: 'u' },
          count: '0',
          created_at: new Date(),
          updated_at: new Date(),
          viewer_voted: false,
        },
      ],
      rowCount: 2,
    });
    const out = await caller().list({ blockToken: 't' });
    expect(out.items[0].viewerVoted).toBe(true);
    expect(out.items[1].viewerVoted).toBe(false);
    const [sql, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    // The vote join + derived boolean are present, keyed on the $4 uid param.
    expect(sql).toContain('.votes v');
    expect(sql).toContain('(v.user_id IS NOT NULL) AS viewer_voted');
    expect(sql).toContain('v.user_id = $4::int');
    // $4 is the RESOLVED subject uid (42) — never client input.
    expect(params[3]).toBe(42);
    // The ONLY reference to a vote row's user_id is the DERIVED boolean — the raw
    // vote rows are never selected/returned.
    expect(sql.match(/v\.user_id/g)?.length).toBe(2); // the JOIN predicate + the boolean
    expect(sql).toContain('(v.user_id IS NOT NULL) AS viewer_voted');
  });

  it('anon viewer passes a NULL uid → the join never matches (viewerVoted false)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' }));
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await caller().list({ blockToken: 't' });
    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBeNull();
  });

  it('is PER-VIEWER: the join keys on the token subject, not a fixed user', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:99' }));
    mockGetSessionUser.mockResolvedValueOnce(trustedUser({ id: 99 }));
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await caller().list({ blockToken: 't' });
    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBe(99);
  });
});

// civitai/civitai#5354 Q3 — `mine`, an author filter on `list`. It is a BOOLEAN,
// never a user id: the author it filters on is the same resolved subject ($4) that
// `viewerVoted` keys on. These tests exist to pin that property structurally, not
// just to show the happy path works — a later change that accepts an author from
// the caller would keep every behavioural assertion green.
describe('#5354 Q3 `mine` author filter on list', () => {
  it('is INERT by default: $5 is false and the guard short-circuits the predicate', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await caller().list({ blockToken: 't' });
    const [sql, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('($5::boolean IS NOT TRUE OR s.author_user_id = $4::int)');
    expect(params[4]).toBe(false);
  });

  // 🔴 There is deliberately NO test here using the DEFAULT fixture subject
  // (user:42). It would assert the same two things as the PER-VIEWER case below
  // and be strictly weaker: a mutant that hardcoded the default uid would survive
  // it. The non-default subject is the only version that is a real control.
  it('🔴 the ONLY author comparison in the list SQL binds $4 — never a caller-supplied param', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await caller().list({ blockToken: 't', mine: true });
    const [sql] = mockPool.query.mock.calls[0] as [string, unknown[]];
    // Structural, not behavioural: `author_user_id = $6` fed from input would pass
    // every other test in this block while turning `mine` into an arbitrary-user
    // enumeration primitive. This is the assertion that fails on that change.
    expect(sql.match(/author_user_id\s*=\s*\$\d+/g)).toEqual(['author_user_id = $4']);
    // And nothing in the list path may reach for an input-shaped author at all.
    expect(sql).not.toMatch(/author_user_id\s*=\s*\$(1|2|3|5|6|7|8|9)\b/);
  });

  it('an ANON caller asking for mine gets an empty page, not the whole board', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' }));
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await caller().list({ blockToken: 't', mine: true });
    const [sql, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    // $4 is NULL for anon, and the predicate is a bare equality — `x = NULL` is
    // UNKNOWN, so it matches nothing. The failure mode this guards against is a
    // refactor to COALESCE($4, s.author_user_id), which would make `mine` return
    // the ENTIRE board to an anonymous caller while every count-based test stays
    // green. Assert the SHAPE, because the behaviour is identical either way
    // against an empty fixture.
    expect(params[3]).toBeNull();
    expect(params[4]).toBe(true);
    expect(sql).toContain('s.author_user_id = $4::int');
    expect(sql).not.toMatch(/COALESCE\s*\(\s*\$4/i);
  });

  it('is PER-VIEWER: a different subject filters on a different author', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'user:99' }));
    mockGetSessionUser.mockResolvedValueOnce(trustedUser({ id: 99 }));
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await caller().list({ blockToken: 't', mine: true });
    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[3]).toBe(99);
    expect(params[4]).toBe(true);
  });

  it('composes with prefix + cursor rather than replacing them', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await caller().list({
      blockToken: 't',
      mine: true,
      prefix: 'grid:',
      cursor: Buffer.from('K9', 'utf8').toString('base64'),
    });
    const [sql, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("s.key LIKE $1 ESCAPE '\\'");
    expect(sql).toContain('($2::text IS NULL OR s.key < $2)');
    expect(sql).toContain('($5::boolean IS NOT TRUE OR s.author_user_id = $4::int)');
    expect(params[0]).toBe('grid:%');
    expect(params[1]).toBe('K9');
    expect(params[4]).toBe(true);
    // Keyset order is untouched — the filter must not change pagination semantics.
    expect(sql).toContain('ORDER BY s.key DESC');
  });
});

// Item 6 — single-row fetch-by-key for `?g=` deep links. READ op (anon-allowed),
// same per-viewer visibility gate (`hidden_at IS NULL`) as `list`.
describe('item 6 apps.shared.get (single-row fetch-by-key)', () => {
  it('returns the row (count + viewerVoted) mapped to the list item shape', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    const created = new Date();
    const updated = new Date();
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          key: 'K',
          author_user_id: 7,
          value: { title: 't', data: { x: 1 } },
          count: '5',
          created_at: created,
          updated_at: updated,
          viewer_voted: true,
        },
      ],
      rowCount: 1,
    });
    const out = await caller().get({ blockToken: 't', key: 'K' });
    expect(out.item).toMatchObject({ key: 'K', authorUserId: 7, count: 5, viewerVoted: true });
    expect((out.item as { value: unknown }).value).toEqual({ title: 't', data: { x: 1 } });
    const [sql, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE s.key = $1 AND s.hidden_at IS NULL');
    expect(sql).toContain('.votes v');
    expect(params[0]).toBe('K');
    expect(params[1]).toBe(42); // resolved subject uid for viewerVoted
  });

  it('returns item:null for a missing key', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const out = await caller().get({ blockToken: 't', key: 'ghost' });
    expect(out.item).toBeNull();
  });

  it('does NOT leak a hidden/moderated row — the query filters hidden_at IS NULL so a hidden row yields item:null', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    // Assert the visibility gate is IN the SQL, and (as the DB would) a hidden row
    // returns no rows → item:null. A get by key can't bypass the list's gate.
    mockPool.query.mockImplementationOnce(async (sql: string) => {
      expect(sql).toContain('hidden_at IS NULL');
      return { rows: [], rowCount: 0 };
    });
    const out = await caller().get({ blockToken: 't', key: 'hidden-row' });
    expect(out.item).toBeNull();
  });

  it('anon may READ a single row (get is a READ op) with a NULL viewer uid', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' }));
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const out = await caller().get({ blockToken: 't', key: 'K' });
    expect(out.item).toBeNull();
    const [, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBeNull();
  });

  it('get requires the READ scope (a write-only token is FORBIDDEN, no DB access)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ scopes: [WRITE] }));
    await expect(caller().get({ blockToken: 't', key: 'K' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('per-app isolation: the get query derives the schema from claims.blockId', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ blockId: 'app-beta' }));
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await caller().get({ blockToken: 't', key: 'K' });
    const sql = (mockPool.query.mock.calls[0] as [string])[0];
    expect(sql).toContain('"app_app_beta".shared_kv');
    expect(sql).not.toContain('app_app_voting');
  });
});

// Item 5 — the `report` procedure ALREADY existed (its emit/report-row behavior
// is covered under "FIX 1 abuse observability"). These pin its AUTHZ: report is a
// WRITE-trust op (not a read), so anon/untrusted/read-only-scope are all denied.
describe('item 5 apps.shared.report authz (write-trust gated)', () => {
  it('a read-only token is FORBIDDEN (report requires the write scope)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ scopes: [READ] }));
    await expect(caller().report({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('anon may NOT report (UNAUTHORIZED)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' }));
    await expect(caller().report({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('an untrusted (too-new) reporter is DENIED (FORBIDDEN)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetSessionUser.mockResolvedValueOnce(trustedUser({ createdAt: new Date() }));
    await expect(caller().report({ blockToken: 't', key: 'k' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('a trusted reporter files the report row and returns { ok: true }', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValue({ rows: [{ x: 1 }], rowCount: 1 }); // row exists + insert
    const out = await caller().report({ blockToken: 't', key: 'req-1', reason: 'spam' });
    expect(out).toEqual({ ok: true });
    const report = (mockPool.query.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      c[0].includes('shared_kv_reports')
    );
    expect(report).toBeTruthy();
    // the reporter uid is the RESOLVED subject (42), never client input
    expect((report![1] as unknown[])[2]).toBe(42);
  });
});

describe('the item’s store card follows an in-app withdraw or moderator hide', () => {
  const modCaller = () =>
    appsModRouter.createCaller(
      fakeCtx({ id: 9, isModerator: true, bannedAt: null, deletedAt: null, muted: false }) as never
    );

  it('an author withdraw that deleted the row withdraws their store item', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockClient.query.mockImplementation(async (sql: string) =>
      sql.startsWith('DELETE') ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 0 }
    );
    await caller().withdraw({ blockToken: 't', key: 'gen-1' });
    expect(mockSyncSubListing).toHaveBeenCalledTimes(1);
    expect(mockSyncSubListing).toHaveBeenCalledWith({
      appBlockId: 'apb_test',
      itemKey: 'gen-1',
      change: 'withdrawn',
      authorUserId: 42,
    });
  });

  it('a withdraw that deleted nothing (not the author) touches no store item', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    await caller().withdraw({ blockToken: 't', key: 'someone-elses' });
    expect(mockSyncSubListing).not.toHaveBeenCalled();
  });

  it.each(['hide', 'delete'] as const)('a moderator %s hides the store item', async (action) => {
    mockDbRead.appBlock.findUnique.mockResolvedValueOnce({ id: 'apb_x', blockId: 'app-voting' });
    await modCaller().purgeSharedRow({ appBlockId: 'apb_x', key: 'gen-1', action });
    expect(mockSyncSubListing).toHaveBeenCalledTimes(1);
    expect(mockSyncSubListing).toHaveBeenCalledWith({
      appBlockId: 'apb_x',
      itemKey: 'gen-1',
      change: 'hidden',
      moderatorId: 9,
    });
  });

  it('a failing mirror never fails the in-app action', async () => {
    mockSyncSubListing.mockRejectedValueOnce(new Error('store unavailable'));
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockClient.query.mockImplementation(async (sql: string) =>
      sql.startsWith('DELETE') ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 0 }
    );
    await expect(caller().withdraw({ blockToken: 't', key: 'gen-1' })).resolves.toEqual({
      ok: true,
      deleted: true,
    });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'app-sub-listing-shared-sync-failed' }),
      undefined
    );
  });
});

describe('M4 mod-purge (session moderatorProcedure)', () => {
  const modCtx = () =>
    fakeCtx({ id: 9, isModerator: true, bannedAt: null, deletedAt: null, muted: false });
  const modCaller = () => appsModRouter.createCaller(modCtx() as never);

  it('DELETE cascades the row (+ files a report)', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValueOnce({ id: 'apb_x', blockId: 'app-voting' });
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DELETE')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const out = await modCaller().purgeSharedRow({
      appBlockId: 'apb_x',
      key: 'bad',
      action: 'delete',
    });
    expect(out).toMatchObject({ ok: true, action: 'delete', affected: 1 });
    const del = (mockClient.query.mock.calls as Array<[string]>).find((c) =>
      c[0].startsWith('DELETE')
    );
    expect(del![0]).toContain('"app_app_voting".shared_kv');
    const report = (mockPool.query.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      c[0].includes('shared_kv_reports')
    );
    expect(String((report![1] as unknown[])[3])).toContain('mod:delete');
  });

  it('HIDE soft-hides (UPDATE hidden_at) without deleting', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValueOnce({ id: 'apb_x', blockId: 'app-voting' });
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.trim().startsWith('UPDATE')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const out = await modCaller().purgeSharedRow({
      appBlockId: 'apb_x',
      key: 'bad',
      action: 'hide',
    });
    expect(out).toMatchObject({ ok: true, action: 'hide', affected: 1 });
    const upd = (mockPool.query.mock.calls as Array<[string]>).find((c) =>
      c[0].trim().startsWith('UPDATE')
    );
    expect(upd![0]).toContain('hidden_at = now()');
  });

  it('is NOT reachable by a non-moderator session (FORBIDDEN)', async () => {
    const nonMod = appsModRouter.createCaller(fakeCtx({ id: 1, isModerator: false }) as never);
    await expect(
      nonMod.purgeSharedRow({ appBlockId: 'apb_x', key: 'k', action: 'hide' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// Generic opaque `data` blob on append: an app-owned, UNMODERATED structured
// payload stored alongside the MODERATED {title, body}. The belt runs on
// title/body ONLY; `data` is contained by the opaque-origin sandbox (same trust
// boundary as the rest of shared storage). Bytes count toward the whole-value cap
// + the per-app quota. See the sharedValueInput note in apps-shared.router.ts.
describe('append `data` blob (opaque, unmoderated app payload)', () => {
  function findInsert() {
    return (mockClient.query.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      c[0].includes('INSERT INTO "app_app_voting".shared_kv')
    );
  }

  it('stores plain-JSON `data` alongside the moderated title/body', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAppendDataPath();
    const data = { buttons: [{ id: 1, weight: 0.8 }], nested: { a: [1, 2, 3] }, s: 'hello' };
    const out = await caller().append({
      blockToken: 't',
      value: { title: 'my config', body: 'notes', data },
    });
    expect(out.key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const insert = findInsert();
    const stored = JSON.parse(String((insert![1] as unknown[])[2])) as {
      title: string;
      body?: string;
      data?: unknown;
    };
    expect(stored.title).toBe('my config');
    expect(stored.body).toBe('notes');
    // plain-JSON `data` round-trips as JSON (structure preserved).
    expect(stored.data).toEqual(data);
  });

  it('list/read returns the raw `value` including `data`', async () => {
    // list returns `value: r.value` verbatim — the jsonb (title/body/data) flows
    // straight through with no belt / no reshaping on read.
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    const rowValue = { title: 't', body: 'b', data: { k: 'v', n: 42 } };
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          key: 'K',
          author_user_id: 42,
          value: rowValue,
          count: '0',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      rowCount: 1,
    });
    const out = await caller().list({ blockToken: 't' });
    expect(out.items[0].value).toEqual(rowValue);
    expect((out.items[0].value as { data?: unknown }).data).toEqual({ k: 'v', n: 42 });
  });

  it('does NOT run `data` through the title/body belt (a "bad" string in data is stored, not rejected, with the data-moderation flags OFF)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAppendDataPath();
    // The SAME string would be REJECTED in `title` (includesMinor); inside `data`
    // it is opaque app state and must pass straight through.
    const out = await caller().append({
      blockToken: 't',
      value: { title: 'clean title', data: { note: '13 year old girl' } },
    });
    expect(out.key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // The belt audited ONLY the moderated text (title), never the data blob.
    expect(mockAuditPromptServer).toHaveBeenCalledTimes(1);
    const auditedPrompt = String(
      (mockAuditPromptServer.mock.calls[0][0] as { prompt: string }).prompt
    );
    expect(auditedPrompt).toContain('clean title');
    expect(auditedPrompt).not.toContain('13 year old girl');
    const stored = JSON.parse(String((findInsert()![1] as unknown[])[2])) as {
      data?: { note?: string };
    };
    expect(stored.data?.note).toBe('13 year old girl');
  });

  it('title/body moderation is UNCHANGED even when a `data` blob is present', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    // A bad TITLE still rejects (belt runs on title) regardless of the data blob.
    await expect(
      caller().append({
        blockToken: 't',
        value: { title: '13 year old girl', data: { anything: true } },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it('rejects an oversized value when `data` pushes the whole value over the cap', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAppendDataPath();
    // title/body are within their own caps; the 70KB data string pushes the whole
    // serialized value over SHARED_VALUE_BYTE_CAP (64KB) → PAYLOAD_TOO_LARGE.
    await expect(
      caller().append({
        blockToken: 't',
        value: { title: 'ok', body: 'ok', data: { big: 'x'.repeat(70 * 1024) } },
      })
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  /**
   * 🔴 THE PROBE'S FAILURE ARM, which only a mocked pool can reach.
   *
   * `requireStoredSize` rejects a null `stored_size_bytes` BEFORE coercing, and throws
   * rather than absorbing it into a 0. Its own docblock calls both choices load-bearing,
   * and both were unpinned: a mutation sweep found that dropping the `raw == null` term
   * (leaving only `Number.isFinite`, which `Number(null) === 0` passes) and replacing
   * the throw with `return 0` each SURVIVED the entire suite — 152 tests at the time,
   * being this file's 146 plus the behaviour file's 6, NOT a count of this file. Either
   * mutant
   * reopens the bypass through the guard instead of around it — a zero-byte charge on
   * append, and a non-positive delta on update, which the non-increasing exemption then
   * waves through.
   *
   * The arm is unreachable via the real SQL (a FROM-less `SELECT octet_length(...)`
   * always yields one non-null row), so there is no behavioural fixture for it — which
   * is exactly why it needs this test rather than none. Asserted on the MESSAGE, so a
   * guard that throws for some other reason does not satisfy it, and on no row being
   * written.
   */
  it('refuses the write loudly when the stored-size probe comes back NULL', async () => {
    // 🔴 NaN AND Infinity ARE IN THIS LOOP DELIBERATELY. `null` and `undefined` are both
    // caught by
    // the guard's FIRST half (`raw == null`), so without a NaN case the second half
    // (`!Number.isFinite(...)`) never decides anything and could be deleted with
    // nothing going red — measured, that mutant SURVIVED the whole suite. NaN is
    // type-valid for `number | null | undefined`, and with the finiteness half gone it
    // fails open through BOTH gates: append gets `usedBytes + NaN > CAP` (false) and
    // update gets `netDelta = NaN`, where `NaN <= 0` and `NaN > CAP` are both false, so
    // the write is ACCEPTED.
    //
    // ⚠️ "Accepted", NOT "charged nothing" — an earlier revision said the latter and the
    // trigger DDL contradicts it. `kv_quota_trigger` charges from the GENERATED column on
    // both paths — `used_bytes + NEW.size_bytes` on INSERT and
    // `used_bytes + (NEW.size_bytes - OLD.size_bytes)` on UPDATE — and never sees
    // `storedByteSize`, so the counter still moves by the true stored size. The harm is that the CEILING stopped binding, not
    // that the accounting broke — which is worse, because the counter keeps looking
    // healthy. Same reasoning that justified pinning the structurally-unreachable null
    // arm.
    //
    // `Infinity` closes the other half of the same asymmetry, and it is here because a
    // sibling guard's docstring started arguing against exactly this: `NaN` alone pins
    // the finiteness check only against DELETION, not against the weakening
    // `!Number.isFinite` -> `Number.isNaN`, which `Infinity` does not satisfy. Measured,
    // that weakening survived the whole suite until this value was added.
    for (const probeValue of [null, undefined, NaN, Infinity, -Infinity]) {
      mockClient.query.mockClear();
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      mockPool.query.mockImplementation(async (sql: string) => {
        if (sql.includes('author_user_id') && sql.includes('count(*)'))
          return { rows: [{ n: '0' }], rowCount: 1 };
        if (sql.includes('.quota'))
          return {
            rows: [{ used_bytes: '0', row_count: '0', stored_size_bytes: probeValue }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      });
      await expect(
        caller().append({ blockToken: 't', value: { title: 'ok', data: [1, 2, 3] } })
      ).rejects.toThrow('stored-size probe returned no usable value');
      // No row was written: the throw lands before the transaction opens.
      expect(mockClient.query).not.toHaveBeenCalled();
    }

    // The mirror case on the UPDATE path, where absorbing a null to 0 would make the
    // delta NEGATIVE and the exemption would then skip the ceiling entirely.
    mockClient.query.mockClear();
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('author_user_id, size_bytes'))
        return { rows: [{ author_user_id: 42, size_bytes: 9000 }], rowCount: 1 };
      if (sql.includes('.quota'))
        return { rows: [{ used_bytes: '0', stored_size_bytes: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(
      caller().update({
        blockToken: 't',
        key: 'ROW-KEY-1',
        value: { title: 'ok', data: [1, 2, 3] },
      })
    ).rejects.toThrow('stored-size probe returned no usable value');
    expect(mockClient.query).not.toHaveBeenCalled();

    // 🔴 POSITIVE CONTROL for the whole test: with a USABLE probe value and the same
    // mocks otherwise, the write goes through. Without this the assertions above are
    // also satisfied by a router that refuses every append.
    mockClient.query.mockClear();
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAppendDataPath();
    await expect(
      caller().append({ blockToken: 't', value: { title: 'ok', data: [1, 2, 3] } })
    ).resolves.toMatchObject({ key: expect.any(String) });
    expect(mockClient.query).toHaveBeenCalled();
  });

  /**
   * 🔴 THE OTHER TERM OF THE SAME SUBTRACTION, in its own test rather than appended to
   * the NULL-probe case above — that title says "probe" and "NULL", and this is neither,
   * so a maintainer chasing the failure would be sent to `requireStoredSize` instead of
   * to the `oldBytes` guard that actually failed.
   *
   * `oldBytes` comes from the generated `shared_kv.size_bytes` column, so a non-numeric
   * value is unreachable with the current DDL (`integer`, non-null, generated over a
   * `jsonb NOT NULL` column) and only a mocked pool can produce one. It is pinned anyway
   * because a NaN there fails open through BOTH arms of the gate — `NaN <= 0` is false
   * so no exemption fires, and `NaN > CAP` is false so no refusal fires — which is the
   * same shape as the probe's null, on the term the probe's guard does not cover.
   *
   * Asserted on this guard's OWN message: the fail-open path reaches the UPDATE, matches
   * no row, and surfaces as the lost-race `request not found`, so a test that only
   * asserted "it throws" would pass against the removed guard.
   */
  it('refuses the write loudly when the stored row size is not numeric', async () => {
    mockClient.query.mockClear();
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('author_user_id, size_bytes'))
        return { rows: [{ author_user_id: 42, size_bytes: 'not-a-number' }], rowCount: 1 };
      if (sql.includes('.quota'))
        return {
          rows: [{ used_bytes: '0', stored_size_bytes: fixtureStoredSize(params) }],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    });
    await expect(
      caller().update({
        blockToken: 't',
        key: 'ROW-KEY-1',
        value: { title: 'ok', data: [1, 2, 3] },
      })
    ).rejects.toThrow('stored row size is not numeric');
    expect(mockClient.query).not.toHaveBeenCalled();

    // POSITIVE CONTROL: a numeric size on the same mocks reaches the write.
    mockClient.query.mockClear();
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('author_user_id, size_bytes'))
        return { rows: [{ author_user_id: 42, size_bytes: 100 }], rowCount: 1 };
      if (sql.includes('.quota'))
        return {
          rows: [{ used_bytes: '0', stored_size_bytes: fixtureStoredSize(params) }],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    });
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.trim().startsWith('UPDATE')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(
      caller().update({
        blockToken: 't',
        key: 'ROW-KEY-1',
        value: { title: 'ok', data: [1, 2, 3] },
      })
    ).resolves.toEqual({ ok: true });
  });

  /**
   * 🔴 THE `quota` COUNTER GUARD, all three of its decisions pinned separately.
   *
   * `requireFiniteCounter` covers `used_bytes` on both write paths and `row_count` on
   * append. A NaN in any of them fails open through both arms of its gate — on append
   * `usedBytes + storedByteSize > CAP` and `rowCount + 1 > LIMIT` are both false against
   * NaN; on update `netDelta` is unaffected so the refusal is false too.
   *
   * ⚠️ EACH ARM BELOW EXISTS BECAUSE A MUTANT SURVIVED WITHOUT IT. An earlier revision
   * fed only `'not-a-number'` and asserted only that the null case was *accepted*, which
   * left three mutants alive: swapping `!Number.isFinite` for `Number.isNaN` (so
   * `'Infinity'` sails through — the very gap the sibling guard's commit existed to
   * close, reopened on this one), dropping the `?? '0'` default, and changing it to
   * `?? '1'`. The arms are labelled with what each one kills.
   */
  it('refuses the write loudly when a quota counter is not numeric', async () => {
    const APP_QUOTA_BYTES = 50 * 1024 * 1024;
    const mockCounters = (counters: Record<string, unknown>, storedSize?: number) =>
      mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('author_user_id') && sql.includes('count(*)'))
          return { rows: [{ n: '0' }], rowCount: 1 };
        if (sql.includes('author_user_id, size_bytes'))
          return { rows: [{ author_user_id: 42, size_bytes: 100 }], rowCount: 1 };
        if (sql.includes('.quota'))
          return {
            rows: [
              {
                row_count: '0',
                ...counters,
                stored_size_bytes: storedSize ?? fixtureStoredSize(params),
              },
            ],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      });
    const value = { title: 'ok', data: [1, 2, 3] };
    const callPath = (path: 'append' | 'update') =>
      path === 'append'
        ? caller().append({ blockToken: 't', value })
        : caller().update({ blockToken: 't', key: 'ROW-KEY-1', value });

    // (a) NON-NUMERIC, both write paths and both counters. Kills the two
    // "drop the guard at this call site" mutants and the "return 0" mutant.
    //
    // 🔴 THE EXPECTED MESSAGE IS EXACT, PER CASE, NOT A DISJUNCTION. An earlier revision
    // asserted `/app (used_bytes|row_count) is not numeric/` for all three, which left a
    // mutant alive that had died before it: relabelling the UPDATE path's guard to
    // `'app row_count'` then satisfied the regex and survived the whole suite. A 500
    // naming the wrong column is the "sent to the wrong helper" failure this file warns
    // about elsewhere, so the label is part of what the guard owes.
    for (const [path, counters, expected] of [
      ['append', { used_bytes: 'not-a-number' }, 'app used_bytes is not numeric'],
      ['update', { used_bytes: 'not-a-number' }, 'app used_bytes is not numeric'],
      ['append', { used_bytes: '0', row_count: 'not-a-number' }, 'app row_count is not numeric'],
    ] as const) {
      mockClient.query.mockClear();
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      mockCounters(counters);
      await expect(callPath(path)).rejects.toThrow(expected);
      expect(mockClient.query).not.toHaveBeenCalled();
    }

    // (b) 🔴 NON-FINITE BUT NOT NaN. `Number('Infinity')` is Infinity, which
    // `Number.isNaN` does NOT catch — this is the only arm that kills the
    // `!Number.isFinite` -> `Number.isNaN` weakening.
    for (const infinite of ['Infinity', '-Infinity', '1e400']) {
      mockClient.query.mockClear();
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      mockCounters({ used_bytes: infinite });
      await expect(callPath('append')).rejects.toThrow('app used_bytes is not numeric');
      expect(mockClient.query).not.toHaveBeenCalled();
    }

    // (c) NULL AND UNDEFINED ARE NOT FAULTS. The scalar subquery returns NULL when the
    // app has no `quota` row, and reading that as zero is the pre-existing behaviour the
    // FROM-less SELECT shape exists to preserve. The `undefined` case is what kills
    // dropping the `?? '0'` default, since `Number(null)` is already 0.
    //
    // ⚠️ Scoped claim: WITHIN THIS FILE these are the only guard on that behaviour. An
    // earlier revision claimed the tightening would otherwise "pass", and that is false —
    // `still accepts a write when the app has no quota row at all` in the behaviour suite
    // also kills it. This arm is the cheap, same-file half of a two-file guard.
    for (const absent of [null, undefined]) {
      mockClient.query.mockClear();
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      mockCounters({ used_bytes: absent, row_count: absent });
      const out = await caller().append({ blockToken: 't', value });
      expect(out.key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(mockClient.query).toHaveBeenCalled();
    }

    // (d) 🔴 AND IT MUST READ AS EXACTLY ZERO, not merely "some small number". The
    // mechanism is an OVERRIDDEN PROBE RESULT, not a resized value: `mockCounters`'
    // second argument replaces `stored_size_bytes` with exactly APP_QUOTA_BYTES, so the
    // gate is evaluated precisely ON the cap. A fallback of 0 accepts (`0 + CAP > CAP` is
    // false) and any positive fallback refuses — so this is the only arm that kills
    // changing `?? '0'` to `?? '1'`. Arm (c) cannot see that, because it asserts
    // acceptance with megabytes of headroom.
    //
    // Two things fall out of overriding the probe rather than the value, both measured.
    // It also kills the append gate's `>` -> `>=` (at the cap, `>=` refuses). And it is
    // what makes this file able to see an append-path wire-unit reintroduction at all:
    // a gate reading the wire `byteSize` ignores the override, so the CAP+1 control below
    // stops refusing. See the note on `fixtureStoredSize` above, which records exactly
    // how far that goes — it is one path, not both.
    mockClient.query.mockClear();
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockCounters({ used_bytes: null }, APP_QUOTA_BYTES);
    const atCap = await caller().append({ blockToken: 't', value });
    expect(atCap.key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // …and the control for (d): one byte more and it refuses, so (d) is not passing just
    // because the gate was never consulted.
    mockClient.query.mockClear();
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockCounters({ used_bytes: null }, APP_QUOTA_BYTES + 1);
    await expect(caller().append({ blockToken: 't', value })).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'app quota exceeded',
    });
  });

  it('counts `data` bytes toward the per-app quota', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    // usedBytes is 50 bytes under the app quota; a data blob larger than that pushes
    // usedBytes + the value's STORED size over APP_QUOTA_BYTES → 'app quota exceeded',
    // proving the `data` bytes reach the gate at all. ⚠️ NOT via `byteSize`, which this
    // comment used to name: the wire `byteSize` is deliberately excluded from this gate
    // now, and the stored size arrives as the `stored_size_bytes` column the mock below
    // supplies (derived from `params[1]`, i.e. the serialized value the router sends).
    const APP_QUOTA_BYTES = 50 * 1024 * 1024;
    mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('author_user_id') && sql.includes('count(*)'))
        return { rows: [{ n: '0' }], rowCount: 1 };
      if (sql.includes('.quota'))
        return {
          rows: [
            {
              used_bytes: String(APP_QUOTA_BYTES - 50),
              row_count: '0',
              stored_size_bytes: fixtureStoredSize(params),
            },
          ],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    });
    await expect(
      caller().append({
        blockToken: 't',
        value: { title: 'ok', data: { pad: 'y'.repeat(500) } },
      })
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', message: 'app quota exceeded' });
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON-serializable `data` (BigInt / circular) with BAD_REQUEST, no row written', async () => {
    // superjson reconstructs real JS values (BigInt / circular / Map / Set) before
    // the handler sees `data`, and z.unknown() does no validation — so JSON.stringify
    // can THROW. The guard must turn that into a clean 4xx, never an unhandled 500,
    // and never write a row.

    // BigInt → "Do not know how to serialize a BigInt".
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAppendDataPath();
    await expect(
      caller().append({ blockToken: 't', value: { title: 'ok', data: 1n } as never })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'value is not serializable' });
    expect(mockClient.query).not.toHaveBeenCalled();

    // Circular structure → "Converting circular structure to JSON".
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAppendDataPath();
    await expect(
      caller().append({ blockToken: 't', value: { title: 'ok', data: circular } as never })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'value is not serializable' });
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it('append with NO `data` stores no `data` key (byte-identical to base)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAppendDataPath();
    await caller().append({ blockToken: 't', value: { title: 'plain' } });
    const stored = JSON.parse(String((findInsert()![1] as unknown[])[2])) as Record<
      string,
      unknown
    >;
    expect(stored).toEqual({ title: 'plain' });
    expect('data' in stored).toBe(false);
  });
});

// Author-scoped in-place UPDATE (`apps.shared.update`). Generic edit of an author's
// OWN published row by key (no app-specific "generator" concept). Write-gated exactly
// like append (shared:write scope + min-trust). Resolves the row by key in the
// caller's app schema, author-gates it, re-runs the belt on the new title/body, caps
// + quota-delta-checks the value, then UPDATEs value + updated_at IN PLACE —
// preserving key / author_user_id / created_at / votes / counters / reports.
describe('apps.shared.update (author-scoped in-place edit)', () => {
  // Mock the update happy-path SELECTs (existing row + quota) and the UPDATE.
  function mockUpdatePath(
    opts: { author?: number; sizeBytes?: number; usedBytes?: number; updatedRows?: number } = {}
  ) {
    const { author = 42, sizeBytes = 100, usedBytes = 0, updatedRows = 1 } = opts;
    mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('author_user_id, size_bytes'))
        return { rows: [{ author_user_id: author, size_bytes: sizeBytes }], rowCount: 1 };
      if (sql.includes('.quota'))
        return {
          rows: [{ used_bytes: String(usedBytes), stored_size_bytes: fixtureStoredSize(params) }],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    });
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql.trim().startsWith('UPDATE')) return { rows: [], rowCount: updatedRows };
      return { rows: [], rowCount: 0 };
    });
  }
  // No existing row (missing OR hidden — the SELECT filters hidden_at IS NULL).
  function mockUpdateNoRow() {
    mockPool.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  }
  function findUpdate() {
    return (mockClient.query.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      c[0].trim().startsWith('UPDATE')
    );
  }

  it('author edits their OWN row in place — value changed, SAME key, no key/author/created_at/vote reset', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockUpdatePath();
    const out = await caller().update({
      blockToken: 't',
      key: 'ROW-KEY-1',
      value: { title: 'edited title', body: 'edited body' },
    });
    expect(out).toEqual({ ok: true });

    const upd = findUpdate();
    expect(upd).toBeTruthy();
    // In-place: only value + updated_at change; author + visibility gated in WHERE.
    expect(upd![0]).toContain('"app_app_voting".shared_kv');
    expect(upd![0]).toContain('SET value = $2::jsonb');
    expect(upd![0]).toContain('updated_at = now()');
    expect(upd![0]).toContain('WHERE key = $1');
    expect(upd![0]).toContain('author_user_id = $3');
    expect(upd![0]).toContain('hidden_at IS NULL');
    // Preservation proof: the key is NOT rewritten, created_at is NOT touched, and the
    // votes/counters/reports tables are never referenced (no DELETE, no cascade).
    expect(upd![0]).not.toContain('created_at');
    expect(upd![0]).not.toMatch(/\.votes\b/);
    expect(upd![0]).not.toMatch(/\.counters\b/);
    expect(upd![0]).not.toMatch(/shared_kv_reports/);
    const delCall = (mockClient.query.mock.calls as Array<[string]>).find((c) =>
      c[0].trim().startsWith('DELETE')
    );
    expect(delCall).toBeFalsy();
    // Params: key preserved (param[0]), new value serialized (param[1]), uid (param[2]).
    const params = upd![1] as unknown[];
    expect(params[0]).toBe('ROW-KEY-1'); // key unchanged
    expect(params[2]).toBe(42); // the token-subject uid, not client input
    const stored = JSON.parse(String(params[1])) as { title: string; body?: string };
    expect(stored.title).toBe('edited title');
    expect(stored.body).toBe('edited body');
    // Quota GUC set so the UPDATE trigger reclaims the byte delta.
    const guc = (mockClient.query.mock.calls as Array<[string]>).find((c) =>
      c[0].includes('SET LOCAL app.current_app_block_id')
    );
    expect(guc).toBeTruthy();
  });

  it('a non-author is FORBIDDEN and nothing is written', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockUpdatePath({ author: 999 }); // row owned by someone else
    await expect(
      caller().update({ blockToken: 't', key: 'ROW-KEY-1', value: { title: 'hijack' } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('a missing key is NOT_FOUND', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockUpdateNoRow();
    await expect(
      caller().update({ blockToken: 't', key: 'ghost', value: { title: 'x' } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('a HIDDEN key is NOT_FOUND (the resolve SELECT filters hidden_at IS NULL)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    // A hidden row returns no rows from the `hidden_at IS NULL` SELECT → NOT_FOUND.
    mockUpdateNoRow();
    await expect(
      caller().update({ blockToken: 't', key: 'hidden-row', value: { title: 'x' } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const sel = (mockPool.query.mock.calls as Array<[string]>).find((c) =>
      c[0].includes('author_user_id, size_bytes')
    );
    expect(sel![0]).toContain('hidden_at IS NULL');
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('a policy-violating (minor) title edit is REJECTED by the belt — no write, report filed', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockUpdatePath();
    await expect(
      caller().update({ blockToken: 't', key: 'ROW-KEY-1', value: { title: '13 year old girl' } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // no in-place write happened
    expect(findUpdate()).toBeFalsy();
    expect(mockPool.connect).not.toHaveBeenCalled();
    // the belt filed an auto: report (same machinery as append)
    const report = (mockPool.query.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      c[0].includes('shared_kv_reports')
    );
    expect(report).toBeTruthy();
    expect(String((report![1] as unknown[])[3])).toContain('auto:');
  });

  it('a blocked-link body edit is REJECTED (belt runs on the new text) — no write', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockUpdatePath();
    mockThrowOnBlockedUserContent.mockRejectedValueOnce(new Error('invalid urls'));
    await expect(
      caller().update({
        blockToken: 't',
        key: 'ROW-KEY-1',
        value: { title: 'ok', body: 'visit http://bad.example' },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(findUpdate()).toBeFalsy();
  });

  it('an oversized value (data pushes over the 64KB cap) → PAYLOAD_TOO_LARGE, no write', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockUpdatePath();
    await expect(
      caller().update({
        blockToken: 't',
        key: 'ROW-KEY-1',
        value: { title: 'ok', data: { big: 'x'.repeat(70 * 1024) } },
      })
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('a non-JSON-serializable value (BigInt) → BAD_REQUEST, no write', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockUpdatePath();
    await expect(
      caller().update({
        blockToken: 't',
        key: 'ROW-KEY-1',
        value: { title: 'ok', data: 1n } as never,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'value is not serializable' });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('quota DELTA respected: a growing edit that exceeds the app quota → PAYLOAD_TOO_LARGE', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    const APP_QUOTA_BYTES = 50 * 1024 * 1024;
    // old row is 100 bytes; used_bytes sits 50 under the cap; a ~500-byte pad grows
    // the value so used + (new − 100) > cap.
    mockUpdatePath({ sizeBytes: 100, usedBytes: APP_QUOTA_BYTES - 50 });
    await expect(
      caller().update({
        blockToken: 't',
        key: 'ROW-KEY-1',
        value: { title: 'ok', data: { pad: 'y'.repeat(500) } },
      })
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', message: 'app quota exceeded' });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('quota DELTA respected: a SHRINKING edit passes even when the app is near the cap', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    const APP_QUOTA_BYTES = 50 * 1024 * 1024;
    // old row is huge (10KB) and the app is 10 bytes under the cap; the tiny new value
    // makes the delta NEGATIVE, so it must fit — proving the check is on the delta.
    mockUpdatePath({ sizeBytes: 10 * 1024, usedBytes: APP_QUOTA_BYTES - 10 });
    const out = await caller().update({
      blockToken: 't',
      key: 'ROW-KEY-1',
      value: { title: 'tiny' },
    });
    expect(out).toEqual({ ok: true });
    expect(findUpdate()).toBeTruthy();
  });

  it('`data` bypasses the belt (freely updatable) while title/body stay moderated', async () => {
    // A clean title + a "bad" string inside data → stored, not rejected.
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockUpdatePath();
    const out = await caller().update({
      blockToken: 't',
      key: 'ROW-KEY-1',
      value: { title: 'clean title', data: { note: '13 year old girl' } },
    });
    expect(out).toEqual({ ok: true });
    // belt audited ONLY the moderated title, never the data blob
    expect(mockAuditPromptServer).toHaveBeenCalledTimes(1);
    const audited = String((mockAuditPromptServer.mock.calls[0][0] as { prompt: string }).prompt);
    expect(audited).toContain('clean title');
    expect(audited).not.toContain('13 year old girl');
    const stored = JSON.parse(String((findUpdate()![1] as unknown[])[1])) as {
      data?: { note?: string };
    };
    expect(stored.data?.note).toBe('13 year old girl');

    // But a bad TITLE with a data blob present still rejects (belt runs on title).
    // Reset the connect/client spies so we can assert THIS attempt never wrote.
    mockPool.connect.mockClear();
    mockClient.query.mockClear();
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockUpdatePath();
    await expect(
      caller().update({
        blockToken: 't',
        key: 'ROW-KEY-1',
        value: { title: '13 year old girl', data: { anything: true } },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('lost race: the in-place UPDATE affects 0 rows → NOT_FOUND', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockUpdatePath({ updatedRows: 0 }); // row vanished/hidden/reassigned mid-op
    await expect(
      caller().update({ blockToken: 't', key: 'ROW-KEY-1', value: { title: 'ok' } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('shares append’s daily rate-limit bucket (over cap → TOO_MANY_REQUESTS, no row lookup)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockCheckAppendRl.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60 });
    await expect(
      caller().update({ blockToken: 't', key: 'ROW-KEY-1', value: { title: 'x' } })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mockCheckAppendRl).toHaveBeenCalledTimes(1);
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  // Scope + trust gating is IDENTICAL to append (both are non-read write ops).
  describe('scope + trust gating identical to append', () => {
    it('a token missing the write scope → FORBIDDEN', async () => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ scopes: [READ] }));
      await expect(
        caller().update({ blockToken: 't', key: 'k', value: { title: 'x' } })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('an anon subject → UNAUTHORIZED (writes require an authenticated viewer)', async () => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' }));
      await expect(
        caller().update({ blockToken: 't', key: 'k', value: { title: 'x' } })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    const untrusted: Array<[string, Record<string, unknown>]> = [
      ['banned', { bannedAt: new Date() }],
      ['muted', { muted: true }],
      ['too-new account', { createdAt: new Date() }],
      ['unverified email', { emailVerified: undefined }],
      ['onboarding incomplete', { onboarding: 0 }],
    ];
    for (const [name, over] of untrusted) {
      it(`an untrusted writer (${name}) → FORBIDDEN, no DB access`, async () => {
        mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
        mockGetSessionUser.mockResolvedValueOnce(trustedUser(over));
        await expect(
          caller().update({ blockToken: 't', key: 'k', value: { title: 'x' } })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(mockPool.query).not.toHaveBeenCalled();
      });
    }

    it('the FLAG DARK kill-switch refuses update (FORBIDDEN)', async () => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      mockIsSharedEnabled.mockResolvedValueOnce(false);
      await expect(
        caller().update({ blockToken: 't', key: 'k', value: { title: 'x' } })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });
});

// ── THE SEAM: the six exported write functions ARE the REST surface ───────────
//
// 🔴 EVERY test above this line drives the tRPC caller. That proves the six write
// bodies behave when reached through `appsSharedRouter` — and it proves NOTHING
// about the path `/api/v1/blocks/shared-storage/*` actually takes, which is a
// bare bearer STRING handed straight to the exported function. Those are two
// entry points into one body, and "verified in isolation" is exactly how a seam
// nobody owns ships broken: the route tests mock the function away, and the tests
// above never call it with a bearer.
//
// So call the exported functions DIRECTLY, with the argument shape the REST
// adapters pass, and re-assert the three security behaviours that a happy-path
// route test cannot see. Table-driven over all six, because a gate wired on five
// of six is the realistic failure, not a gate wired on none.
describe('REST entry shape — the six exported write functions carry the full ladder', () => {
  // Pairwise-distinct, non-zero fixture values so a transposition (key passed as
  // reason, uid passed as appBlockId) and a hardcoded constant both die.
  const KEY = 'k-seam-771';
  const REASON = 'seam-reason-883';
  const VALUE = { title: 'seam title 559', body: 'seam body 661', data: { n: 997 } };

  const OPS: Array<{
    name: string;
    call: () => Promise<unknown>;
    /** The bucket this op MUST spend, and the two it must not. */
    bucket: () => typeof mockCheckAppendRl;
    otherBuckets: () => Array<typeof mockCheckAppendRl>;
    retryAfter: number;
    tooManyMessage: string;
  }> = [
    {
      name: 'appendSharedRow',
      call: () => appendSharedRow('tok_seam', VALUE),
      bucket: () => mockCheckAppendRl,
      otherBuckets: () => [mockCheckVoteRl, mockCheckReportRl, mockCheckWithdrawRl],
      retryAfter: 11,
      tooManyMessage: 'Too many submissions — retry in 11s',
    },
    {
      name: 'updateSharedRow',
      call: () => updateSharedRow('tok_seam', KEY, VALUE),
      bucket: () => mockCheckAppendRl,
      otherBuckets: () => [mockCheckVoteRl, mockCheckReportRl, mockCheckWithdrawRl],
      retryAfter: 13,
      tooManyMessage: 'Too many submissions — retry in 13s',
    },
    {
      name: 'voteSharedRow',
      call: () => voteSharedRow('tok_seam', KEY),
      bucket: () => mockCheckVoteRl,
      otherBuckets: () => [mockCheckAppendRl, mockCheckReportRl, mockCheckWithdrawRl],
      retryAfter: 19,
      tooManyMessage: 'Too many votes — retry in 19s',
    },
    {
      name: 'unvoteSharedRow',
      call: () => unvoteSharedRow('tok_seam', KEY),
      bucket: () => mockCheckVoteRl,
      otherBuckets: () => [mockCheckAppendRl, mockCheckReportRl, mockCheckWithdrawRl],
      retryAfter: 23,
      tooManyMessage: 'Too many votes — retry in 23s',
    },
    {
      name: 'withdrawSharedRow',
      call: () => withdrawSharedRow('tok_seam', KEY),
      bucket: () => mockCheckWithdrawRl,
      otherBuckets: () => [mockCheckAppendRl, mockCheckVoteRl, mockCheckReportRl],
      retryAfter: 29,
      tooManyMessage: 'Too many withdrawals — retry in 29s',
    },
    {
      name: 'reportSharedRow',
      call: () => reportSharedRow('tok_seam', KEY, REASON),
      bucket: () => mockCheckReportRl,
      otherBuckets: () => [mockCheckAppendRl, mockCheckVoteRl, mockCheckWithdrawRl],
      retryAfter: 31,
      tooManyMessage: 'Too many reports — retry in 31s',
    },
  ];

  it.each(OPS)('$name: the bearer token is VERIFIED, not trusted', async ({ call }) => {
    mockVerifyBlockToken.mockResolvedValueOnce(null);
    await expect(call()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // The token string this surface receives is the ONLY credential, so a body
    // that reached the DB before verifying it would be an unauthenticated write.
    expect(mockVerifyBlockToken).toHaveBeenCalledWith('tok_seam');
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it.each(OPS)(
    '$name: an ANON token is refused UNAUTHORIZED, before any DB work',
    async ({ call }) => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' }));
      await expect(call()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(mockPool.query).not.toHaveBeenCalled();
      expect(mockPool.connect).not.toHaveBeenCalled();
    }
  );

  it.each(OPS)(
    '$name: a subject BELOW min-trust is refused, before any DB work',
    async ({ call }) => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      // 2 days old: fails the account-age leg of assertSharedWriteTrust while every
      // other signal passes, so the refusal can only come from the trust gate.
      mockGetSessionUser.mockResolvedValueOnce(
        trustedUser({ createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
      );
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockPool.query).not.toHaveBeenCalled();
      expect(mockPool.connect).not.toHaveBeenCalled();
    }
  );

  it.each(OPS)(
    '$name: a token WITHOUT apps:storage:shared:write is refused FORBIDDEN',
    async ({ call }) => {
      // The read scope alone must not reach a write body — the routes all declare
      // the write scope in `withBlockScope`, but that middleware is mocked out of
      // every route test, so this is the only place the claim is actually checked.
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ scopes: [READ] }));
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mockPool.query).not.toHaveBeenCalled();
      expect(mockPool.connect).not.toHaveBeenCalled();
    }
  );

  it.each(OPS)(
    '$name: over its rate-limit cap → TOO_MANY_REQUESTS, refused BEFORE a connection is taken',
    async ({ call, bucket, retryAfter, tooManyMessage }) => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      bucket().mockResolvedValueOnce({ allowed: false, retryAfterSeconds: retryAfter });
      await expect(call()).rejects.toMatchObject({
        code: 'TOO_MANY_REQUESTS',
        // Every retryAfter in this table is distinct and non-zero, so a body that
        // echoed a sibling bucket's result — or a constant — fails here rather
        // than passing on a shared value.
        message: tooManyMessage,
      });
      // 🔴 The limiter's POSITION is the claim, not its presence: refused before a
      // pooled connection AND before the first query, so a flood costs neither.
      expect(mockPool.connect).not.toHaveBeenCalled();
      expect(mockPool.query).not.toHaveBeenCalled();
    }
  );

  it.each(OPS)(
    '$name: spends its OWN bucket, keyed on (subject user, appBlockId)',
    async ({ call, bucket, otherBuckets }) => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      mockAppendDataPath();
      await call().catch(() => undefined);
      expect(bucket()).toHaveBeenCalledWith(42, 'apb_test');
      for (const other of otherBuckets()) expect(other).not.toHaveBeenCalled();
    }
  );

  // POSITIVE CONTROL for the five refusal cases above. Without it, a harness that
  // rejected everything (a broken `validClaims`, a mock left rejecting) would make
  // all of them pass while proving nothing — a reassuring red is as blind as a
  // reassuring zero.
  it('POSITIVE CONTROL: a trusted, in-scope, under-cap subject reaches the data path', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAppendDataPath();
    const out = await appendSharedRow('tok_seam', VALUE);
    expect(out.key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(mockPool.connect).toHaveBeenCalled();
  });

  it('reportSharedRow forwards the REASON it was given, not a default', async () => {
    // Guards the one write whose third argument is free text: a body that dropped
    // it would still return { ok: true } and look fine.
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
    await reportSharedRow('tok_seam', KEY, REASON);
    const reportInsert = mockPool.query.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('shared_kv_reports')
    );
    expect(reportInsert?.[1]).toEqual(expect.arrayContaining([KEY, 42, REASON]));
  });
});

// ── `data` leaf moderation (shadow → enforce) ─────────────────────────────────
//
// Behaviour of the two per-app flags on the append/update paths. The tRPC procedures and the REST
// adapters (`/api/v1/blocks/shared-storage/{append,update}`) call the SAME exported functions, so
// the REST surface is covered by the `appendSharedRow`/`updateSharedRow` cases here.
describe('shared `data` local moderation', () => {
  const SHADOW_FLAG = 'app-blocks-shared-data-moderation';
  const ENFORCE_FLAG = 'app-blocks-shared-data-moderation-enforce';
  const MINOR = '13 year old girl';

  function setFlags({ shadow = false, enforce = false }: { shadow?: boolean; enforce?: boolean }) {
    mockIsFlipt.mockImplementation(async (flag: string) =>
      flag === SHADOW_FLAG ? shadow : flag === ENFORCE_FLAG ? enforce : false
    );
  }
  function insertedValue(): string | undefined {
    const insert = (mockClient.query.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      c[0].includes('INSERT INTO "app_app_voting".shared_kv')
    );
    return insert ? String((insert[1] as unknown[])[2]) : undefined;
  }
  function reportReasons(): string[] {
    return (mockPool.query.mock.calls as Array<[string, unknown[]?]>)
      .filter((c) => c[0].includes('shared_kv_reports'))
      .map((c) => String((c[1] as unknown[])[3]));
  }
  function eventNames(): string[] {
    return mockLogToAxiom.mock.calls.map((c) => String((c[0] as { name?: string }).name));
  }
  const flushImmediates = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  function deepArray(depth: number, leaf: unknown): unknown {
    let value = leaf;
    for (let i = 0; i < depth; i++) value = [value];
    return value;
  }
  async function appendData(data: unknown) {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAppendDataPath();
    return appendSharedRow('tok', { title: 'clean title', data });
  }

  describe('INVARIANT GUARD: both flags OFF is the pre-moderation behaviour', () => {
    it('a flagged term in `data` is stored byte-for-byte, nothing is scanned, recorded or scheduled', async () => {
      const value = { title: 'clean title', body: 'b', data: { x: MINOR, [MINOR]: [1] } };
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      mockAppendDataPath();
      await expect(appendSharedRow('tok', value)).resolves.toMatchObject({
        key: expect.any(String),
      });
      await flushImmediates();
      expect(insertedValue()).toBe(JSON.stringify(value));
      expect(mockFindBlocked).not.toHaveBeenCalled();
      expect(mockChInsert).not.toHaveBeenCalled();
      expect(eventNames()).not.toContain('app-blocks-shared-data-moderation-scan');
      expect(reportReasons()).toEqual([]);
      // ...and the flags were asked, per app, with no user context.
      expect(mockIsFlipt).toHaveBeenCalledWith(SHADOW_FLAG, 'apb_test', undefined);
      expect(mockIsFlipt).toHaveBeenCalledWith(ENFORCE_FLAG, 'apb_test', undefined);
    });
  });

  describe('ENFORCE', () => {
    beforeEach(() => setFlags({ enforce: true }));

    it.each([
      ['a string value `data.x`', { x: MINOR }],
      ['an OBJECT KEY', { tags: { [MINOR]: true } }],
      ['a leaf 20 arrays deep', { nest: deepArray(20, MINOR) }],
      ['a format-character-split term', { x: 'lo​li' }],
    ])(
      '🔴 REGRESSION: a flagged term in %s → BAD_REQUEST, nothing written',
      async (_name, data) => {
        await expect(appendData(data)).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: 'Content flagged for review',
        });
        expect(mockPool.connect).not.toHaveBeenCalled();
        expect(insertedValue()).toBeUndefined();
      }
    );

    it('a minor hit files a Report row and the legal-block alert, as a title/body hit does', async () => {
      await appendData({ x: MINOR }).catch(() => undefined);
      expect(reportReasons()).toEqual(['auto:data:minor']);
      const legal = mockLogToAxiom.mock.calls.find(
        (c) => (c[0] as { name?: string }).name === 'app-blocks-shared-storage-legal-block'
      );
      expect(legal?.[0]).toMatchObject({
        category: 'minor',
        field: 'data',
        appBlockId: 'apb_test',
      });
      // The alert carries metadata only.
      expect(JSON.stringify(legal?.[0])).not.toContain(MINOR);
    });

    it('🔴 REGRESSION: an over-cap blob (33 deep) is rejected, without a Report row', async () => {
      await expect(appendData(deepArray(33, 'x'))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Data is too large or too deeply nested to review',
      });
      expect(mockPool.connect).not.toHaveBeenCalled();
      expect(reportReasons()).toEqual([]);
    });

    it('a blocked link in a leaf → the link message, no Report row', async () => {
      // Leaves are [key `url`, value `see bad.example`]; the hit is on the VALUE.
      mockFindBlocked.mockResolvedValue([{ kind: 'link', index: 1, matched: ['bad.example'] }]);
      await expect(appendData({ url: 'see bad.example' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Content contains a blocked link',
      });
      expect(reportReasons()).toEqual([]);
    });

    it('records the rejected hit with blocked=1, no row key (a create that never got one) and NO leaf text', async () => {
      await appendData({ x: MINOR }).catch(() => undefined);
      await vi.waitFor(() => expect(mockChInsert).toHaveBeenCalled());
      const rows = mockChInsert.mock.calls[0][0].values as Array<Record<string, unknown>>;
      expect(rows).toContainEqual(
        expect.objectContaining({
          category: 'minor',
          blocked: 1,
          mode: 'enforce',
          rowKey: '',
          // Enforce hashes every user-written key in the path (here the one key, `x`).
          leafPath: `#${createHash('sha256').update('x').digest('hex').slice(0, 16)}`,
          // Enforce stores hashes, platform labels and metadata only — never the text.
          leafText: '',
        })
      );
      expect(JSON.stringify(rows)).not.toContain(MINOR);
    });

    it('🔴 REGRESSION: the scan reads the STORED form — a revived `URL` is scanned as the href it serialises to', async () => {
      // A superjson-revived value is an object with no own keys, so a scan of `value.data` as
      // received would read nothing in it. Stored, it is its `toJSON()` string.
      const site = new URL('https://example.com/gallery/loli');
      await expect(appendData({ site })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Content flagged for review',
      });
      expect(mockPool.connect).not.toHaveBeenCalled();
      expect(mockFindBlocked.mock.calls[0][0]).toContain(site.href);
    });

    it('the stored form of a revived `Date` is its ISO string (read, and clean)', async () => {
      const at = new Date('2026-10-08T01:02:03.456Z');
      await expect(appendData({ at })).resolves.toMatchObject({ key: expect.any(String) });
      expect(mockFindBlocked.mock.calls[0][0]).toEqual(['at', at.toISOString()]);
    });

    it('clean `data` is written, and the scan still emits its denominator', async () => {
      await expect(appendData({ label: 'a calm lake', n: 3 })).resolves.toMatchObject({
        key: expect.any(String),
      });
      expect(insertedValue()).toBeDefined();
      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app-blocks-shared-data-moderation-scan',
          mode: 'enforce',
          blocked: false,
          leafCount: 3,
        }),
        'block-audit'
      );
    });

    it('title/body still run first: a bad TITLE is refused by the title/body belt before `data` is read', async () => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      await expect(
        appendSharedRow('tok', { title: MINOR, data: { x: 'clean' } })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockFindBlocked).not.toHaveBeenCalled();
      expect(reportReasons()).toEqual(['auto:minor']);
    });

    it('🔴 REGRESSION (update): a flagged key in edited `data` → BAD_REQUEST, no UPDATE', async () => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('author_user_id, size_bytes'))
          return { rows: [{ author_user_id: 42, size_bytes: 100 }], rowCount: 1 };
        if (sql.includes('.quota'))
          return {
            rows: [{ used_bytes: '0', stored_size_bytes: fixtureStoredSize(params) }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      });
      await expect(
        updateSharedRow('tok', 'ROW-KEY-1', { title: 'clean', data: { [MINOR]: 1 } })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Content flagged for review' });
      expect(mockPool.connect).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(mockChInsert).toHaveBeenCalled());
      expect(mockChInsert.mock.calls[0][0].values).toContainEqual(
        expect.objectContaining({
          // Enforce never stores the key verbatim (a counter-anchor row's key is user text); its
          // hash still joins the hit to the row.
          rowKey: '',
          rowKeySha256: createHash('sha256').update('ROW-KEY-1').digest('hex'),
          surface: 'update',
          leafKind: 'key',
        })
      );
    });

    it.each([
      ['poi', 'emma watson', ['auto:data:poi'], 'app-blocks-shared-storage-legal-block'],
      ['audit_regex', 'fuck', ['auto:data:audit_regex'], 'app-blocks-shared-storage-content-block'],
    ])(
      'a %s hit → BAD_REQUEST with its Report row and alert',
      async (_category, text, reasons, alertName) => {
        await expect(appendData({ x: text })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(reportReasons()).toEqual(reasons);
        expect(eventNames()).toContain(alertName);
      }
    );

    it('a PATTERN hit follows user-content-pattern-enforce, as title/body does: recorded, not rejected, while it is off', async () => {
      mockFindBlocked.mockResolvedValue([{ kind: 'pattern', index: 1, matched: 'scam phrase' }]);
      await expect(appendData({ note: 'a scam phrase here' })).resolves.toMatchObject({
        key: expect.any(String),
      });
      expect(mockGetFliptBoolean).toHaveBeenCalledWith('user-content-pattern-enforce');
      await vi.waitFor(() => expect(mockChInsert).toHaveBeenCalled());
      expect(mockChInsert.mock.calls[0][0].values).toEqual([
        expect.objectContaining({ category: 'pattern', blocked: 0, mode: 'enforce' }),
      ]);
      expect(reportReasons()).toEqual([]);
    });

    it('…and rejected, without a Report row, once user-content-pattern-enforce is on', async () => {
      mockGetFliptBoolean.mockResolvedValue(true);
      mockFindBlocked.mockResolvedValue([{ kind: 'pattern', index: 1, matched: 'scam phrase' }]);
      await expect(appendData({ note: 'a scam phrase here' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Content flagged for review',
      });
      expect(mockPool.connect).not.toHaveBeenCalled();
      expect(reportReasons()).toEqual([]);
    });

    it('reads user-content-pattern-enforce only when a pattern hit exists', async () => {
      await appendData({ x: 'a calm lake' });
      expect(mockGetFliptBoolean).not.toHaveBeenCalled();
    });

    it.each([
      ['leaves', Array.from({ length: 1001 }, (_, i) => `leaf ${'abcdefghij'[i % 10]}${i}`)],
      ['chars', ['a'.repeat(32_001), 'b'.repeat(32_000)]],
    ])('🔴 REGRESSION: a blob over the %s cap is rejected', async (_cap, data) => {
      await expect(appendData(data)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Data is too large or too deeply nested to review',
      });
      expect(mockPool.connect).not.toHaveBeenCalled();
    });

    it('SEAM: the subject’s moderator bit reaches the blocklist (patterns exempt for mods only)', async () => {
      await appendData({ x: 'a calm lake' });
      expect(mockFindBlocked.mock.calls[0][1]).toEqual({ exemptFromPatterns: false });
      mockGetSessionUser.mockResolvedValue(trustedUser({ isModerator: true }));
      await appendData({ x: 'a calm lake' });
      expect(mockFindBlocked.mock.calls[1][1]).toEqual({ exemptFromPatterns: true });
    });

    it('a blocklist outage during the scan is a clean 4xx, not a 500 — and nothing is written', async () => {
      mockFindBlocked.mockRejectedValue(new Error('redis down'));
      const error = await appendData({ x: 'a calm lake' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Content could not be reviewed right now. Please try again.',
      });
      // A 4xx to the caller, but logged as the outage it is.
      expect(isEscalatedServerFault(error)).toBe(true);
      expect(mockPool.connect).not.toHaveBeenCalled();
      expect(eventNames()).toContain('app-blocks-shared-data-moderation-scan-failed');
      expect(JSON.stringify(mockLogToAxiom.mock.calls)).not.toContain('redis down');
    });

    it('🔴 a minor hit is still REPORTED when the same write also overflows (legal signal wins attribution)', async () => {
      await expect(appendData({ x: MINOR, big: 'a '.repeat(10_001) })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Content flagged for review',
      });
      expect(reportReasons()).toEqual(['auto:data:minor']);
      expect(eventNames()).toContain('app-blocks-shared-storage-legal-block');
    });

    it('a single leaf too long to audit is rejected as unreviewable — WITHOUT a Report row', async () => {
      await expect(appendData({ big: 'a '.repeat(10_001) })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Data is too large or too deeply nested to review',
      });
      expect(reportReasons()).toEqual([]);
      expect(eventNames()).not.toContain('app-blocks-shared-storage-content-block');
    });

    it('enforce ON with shadow ALSO on scans once, inline — no second post-commit scan', async () => {
      setFlags({ shadow: true, enforce: true });
      await appendData({ label: 'a calm lake' });
      await flushImmediates();
      expect(mockFindBlocked).toHaveBeenCalledTimes(1);
      const scans = eventNames().filter((n) => n === 'app-blocks-shared-data-moderation-scan');
      expect(scans).toHaveLength(1);
    });
  });

  describe('SHADOW', () => {
    beforeEach(() => setFlags({ shadow: true }));

    it('🔴 REGRESSION: a flagged term is RECORDED against the committed row — and the write is not refused', async () => {
      const out = await appendData({ x: MINOR, list: [{ [MINOR]: 1 }] });
      expect(insertedValue()).toBeDefined();
      await vi.waitFor(() => expect(mockChInsert).toHaveBeenCalled());
      const rows = mockChInsert.mock.calls[0][0].values as Array<Record<string, unknown>>;
      expect(rows).toContainEqual(
        expect.objectContaining({
          rowKey: out.key,
          surface: 'append',
          mode: 'shadow',
          blocked: 0,
          category: 'minor',
          leafPath: 'x',
          leafKind: 'value',
          leafText: MINOR,
        })
      );
    });

    it('🔴 REGRESSION: shadow scans the STORED form too — a revived `URL`’s href is recorded', async () => {
      const site = new URL('https://example.com/gallery/loli');
      await appendData({ site });
      await vi.waitFor(() => expect(mockChInsert).toHaveBeenCalled());
      const rows = mockChInsert.mock.calls[0][0].values as Array<Record<string, unknown>>;
      expect(rows).toContainEqual(
        expect.objectContaining({ mode: 'shadow', leafPath: 'site', leafText: site.href })
      );
    });

    it('INVARIANT GUARD: shadow has NO consequences — no Report row, no block alert, no extra belt call', async () => {
      await appendData({ x: MINOR, y: 'emma watson' });
      await vi.waitFor(() => expect(mockChInsert).toHaveBeenCalled());
      await flushImmediates();
      expect(reportReasons()).toEqual([]);
      expect(eventNames()).not.toContain('app-blocks-shared-storage-legal-block');
      expect(eventNames()).not.toContain('app-blocks-shared-storage-content-block');
      // Exactly the title/body belt's own calls — shadow added none.
      expect(mockThrowOnBlockedUserContent).toHaveBeenCalledTimes(1);
      expect(mockAuditPromptServer).toHaveBeenCalledTimes(1);
    });

    it('INVARIANT GUARD: shadow is NOT awaited — the write returns while the scan is still pending', async () => {
      // A classifier that never settles: if the write awaited the scan, this would hang.
      mockFindBlocked.mockImplementation(() => new Promise(() => undefined));
      let settled = false;
      let scanCallsWhenSettled = -1;
      const pending = appendData({ x: 'anything' }).then((r) => {
        settled = true;
        scanCallsWhenSettled = mockFindBlocked.mock.calls.length;
        return r;
      });
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000 });
      await expect(pending).resolves.toMatchObject({ key: expect.any(String) });
      // ...and the scan had not even started by then (it is deferred past the request's tick).
      expect(scanCallsWhenSettled).toBe(0);
      await flushImmediates();
      expect(mockFindBlocked).toHaveBeenCalledTimes(1);
      expect(mockChInsert).not.toHaveBeenCalled();
    });

    function mockUpdatePathFor(updatedRows: number) {
      mockPool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('author_user_id, size_bytes'))
          return { rows: [{ author_user_id: 42, size_bytes: 100 }], rowCount: 1 };
        if (sql.includes('.quota'))
          return {
            rows: [{ used_bytes: '0', stored_size_bytes: fixtureStoredSize(params) }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      });
      mockClient.query.mockImplementation(async (sql: string) =>
        sql.trim().startsWith('UPDATE')
          ? { rows: [], rowCount: updatedRows }
          : { rows: [], rowCount: 0 }
      );
    }

    it('🔴 REGRESSION (update): an edited flagged leaf is recorded against the edited row', async () => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      mockUpdatePathFor(1);
      await expect(
        updateSharedRow('tok', 'ROW-KEY-1', { title: 'clean', data: { x: MINOR } })
      ).resolves.toEqual({ ok: true });
      await vi.waitFor(() => expect(mockChInsert).toHaveBeenCalled());
      expect(mockChInsert.mock.calls[0][0].values).toContainEqual(
        expect.objectContaining({
          rowKey: 'ROW-KEY-1',
          surface: 'update',
          mode: 'shadow',
          category: 'minor',
        })
      );
    });

    it('an edit that lost its race (0 rows updated) is never shadow-scanned', async () => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      mockUpdatePathFor(0);
      await expect(
        updateSharedRow('tok', 'ROW-KEY-1', { title: 'clean', data: { x: MINOR } })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await flushImmediates();
      expect(mockFindBlocked).not.toHaveBeenCalled();
    });

    it('SEAM: shadow passes the subject’s moderator bit to the blocklist too', async () => {
      mockGetSessionUser.mockResolvedValue(trustedUser({ isModerator: true }));
      await appendData({ x: 'a calm lake' });
      await vi.waitFor(() => expect(mockFindBlocked).toHaveBeenCalled());
      expect(mockFindBlocked.mock.calls[0][1]).toEqual({ exemptFromPatterns: true });
    });

    it('an over-cap blob is recorded as an overflow, not rejected', async () => {
      await expect(appendData(deepArray(33, 'x'))).resolves.toMatchObject({
        key: expect.any(String),
      });
      await vi.waitFor(() => expect(mockChInsert).toHaveBeenCalled());
      expect(mockChInsert.mock.calls[0][0].values).toEqual([
        expect.objectContaining({ category: 'overflow', matched: 'depth', mode: 'shadow' }),
      ]);
    });

    it('a write refused for another reason (quota) is never shadow-scanned', async () => {
      mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
      mockPool.query.mockImplementation(async (sql: string) => {
        if (sql.includes('author_user_id') && sql.includes('count(*)'))
          return { rows: [{ n: '0' }], rowCount: 1 };
        if (sql.includes('.quota'))
          return {
            rows: [{ used_bytes: String(50 * 1024 * 1024), row_count: '0', stored_size_bytes: 10 }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      });
      await expect(
        appendSharedRow('tok', { title: 't', data: { x: MINOR } })
      ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
      await flushImmediates();
      expect(mockFindBlocked).not.toHaveBeenCalled();
    });
  });
});
