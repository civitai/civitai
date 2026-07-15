import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  mockThrowOnBlockedLinkDomain,
  mockAuditPromptServer,
  mockIsRevoked,
  mockLogToAxiom,
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
    mockDbRead: { appBlock: { findUnique: vi.fn() }, account: { count: vi.fn() } },
    mockIsSharedEnabled: vi.fn(async () => true),
    mockPool,
    mockClient,
    mockGetSessionUser: vi.fn(),
    mockCheckAppendRl: vi.fn(async () => ({ allowed: true })),
    mockCheckVoteRl: vi.fn(async () => ({ allowed: true })),
    mockThrowOnBlockedLinkDomain: vi.fn(async () => undefined),
    mockAuditPromptServer: vi.fn(async () => undefined),
    mockIsRevoked: vi.fn(async () => false),
    mockLogToAxiom: vi.fn(async () => undefined),
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
vi.mock('~/server/utils/shared-storage-rate-limit', () => ({
  checkSharedAppendRateLimit: (...a: unknown[]) => mockCheckAppendRl(...a),
  checkSharedVoteRateLimit: (...a: unknown[]) => mockCheckVoteRl(...a),
}));
// Keep the content-safety belt REAL; mock only its redis-backed deps.
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: (...a: unknown[]) => mockThrowOnBlockedLinkDomain(...a),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: (...a: unknown[]) => mockAuditPromptServer(...a),
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: (...a: unknown[]) => mockIsRevoked(...a) },
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...a: unknown[]) => mockLogToAxiom(...a),
}));
// NOTE: the report op's Discord notify does a dynamic `import('~/env/server')`; we
// deliberately do NOT mock env (mocking it clobbers env.LOGGING and breaks the trpc
// import chain). In the test env DISCORD_WEBHOOK_MOD_ALERTS is unset, so the notify
// short-circuits to a no-op before any fetch — exactly the fire-and-forget path.

import { appsSharedRouter, appsModRouter, sanitizeDiscordText } from '../apps-shared.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';

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
  mockThrowOnBlockedLinkDomain.mockResolvedValue(undefined);
  mockAuditPromptServer.mockResolvedValue(undefined);
  mockLogToAxiom.mockResolvedValue(undefined);
});

// Helper: the append data path needs the row-count + quota SELECTs to resolve so a
// trusted write reaches the INSERT.
function mockAppendDataPath() {
  mockPool.query.mockImplementation(async (sql: string) => {
    if (sql.includes('author_user_id') && sql.includes('count(*)'))
      return { rows: [{ n: '0' }], rowCount: 1 };
    if (sql.includes('.quota'))
      return { rows: [{ used_bytes: '0', row_count: '0' }], rowCount: 1 };
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
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('author_user_id') && sql.includes('count(*)'))
        return { rows: [{ n: '0' }], rowCount: 1 };
      if (sql.includes('.quota'))
        return { rows: [{ used_bytes: '0', row_count: '0' }], rowCount: 1 };
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

  it('anon NEVER writes (UNAUTHORIZED)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' }));
    await expect(
      caller().append({ blockToken: 't', value: { title: 'x' } })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
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
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Verify your email before contributing' });
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
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Your account is not eligible for this action' });
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
    await expect(
      caller().append({ blockToken: 't', value: { title: 'x' } })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
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
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('author_user_id') && sql.includes('count(*)'))
        return { rows: [{ n: '0' }], rowCount: 1 };
      if (sql.includes('.quota'))
        return { rows: [{ used_bytes: '0', row_count: '0' }], rowCount: 1 };
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
    mockThrowOnBlockedLinkDomain.mockRejectedValueOnce(new Error('invalid urls'));
    await expect(
      caller().append({ blockToken: 't', value: { title: 'visit http://bad.example' } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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
    mockThrowOnBlockedLinkDomain.mockRejectedValueOnce(new Error('invalid urls'));
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
    expect(contentEmits[0]).toMatchObject({
      type: 'warning',
      category: 'audit',
      userId: 42,
      slug: 'app_voting',
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
    await expect(
      caller().report({ blockToken: 't', key: 'ghost' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(auditEmits('app-blocks-shared-storage-report')).toHaveLength(0);
  });
});

// FIX 1 (Discord phishing vector): the reporter-supplied `reason` is embedded in
// the mod-alerts Discord message. A hostile reporter must not be able to plant a
// masked/phishing link or other markdown. `sanitizeDiscordText` neutralizes it and
// the embed field wraps the result in an inline code span.
describe('sanitizeDiscordText (mod-alert reason hardening)', () => {
  it('neutralizes a masked link + backticks (no live markdown survives)', () => {
    const hostile = 'click [here](https://phish.example) `rm -rf` **bold** ~~s~~ ||spoiler|| > q';
    const out = sanitizeDiscordText(hostile);
    // structural markdown / masked-link characters are gone
    for (const ch of ['[', ']', '(', ')', '`', '*', '_', '~', '|', '>']) {
      expect(out).not.toContain(ch);
    }
    expect(out).not.toMatch(/\]\(/); // the masked-link `](` sequence specifically
    // the human-readable words survive as inert plain text
    expect(out).toContain('here');
    expect(out).toContain('https://phish.example');
  });

  it('the embed field value (code-span wrapped) contains no live masked link', () => {
    // mirror the exact construction used in notifyModsOfSharedReport
    const fieldValue = `\`${sanitizeDiscordText('[x](http://evil) `boom`') || 'user-report'}\``;
    expect(fieldValue).not.toMatch(/\]\(/); // no masked link
    // exactly two backticks (the wrapping span) — none survived from the input
    expect((fieldValue.match(/`/g) ?? []).length).toBe(2);
    expect(fieldValue.startsWith('`')).toBe(true);
    expect(fieldValue.endsWith('`')).toBe(true);
  });

  it('an all-markdown reason collapses to empty → falls back to user-report', () => {
    const fieldValue = `\`${sanitizeDiscordText('[]()``') || 'user-report'}\``;
    expect(fieldValue).toBe('`user-report`');
  });

  it('caps the sanitized output at 500 chars', () => {
    expect(sanitizeDiscordText('a'.repeat(1000)).length).toBe(500);
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
});

describe('isolation + read invariants', () => {
  it('list reads ONLY shared_kv/counters (never kv/votes), excludes hidden', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await caller().list({ blockToken: 't' });
    const sql = (mockPool.query.mock.calls[0] as [string])[0];
    expect(sql).toContain('.shared_kv');
    expect(sql).toContain('.counters');
    expect(sql).toContain('hidden_at IS NULL');
    expect(sql).not.toMatch(/\.kv\b/);
    expect(sql).not.toMatch(/\.votes\b/);
  });

  it('per-app isolation: schema derives from claims.blockId (app A ≠ app B)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ blockId: 'app-beta' }));
    await caller().list({ blockToken: 't' });
    const sql = (mockPool.query.mock.calls[0] as [string])[0];
    expect(sql).toContain('"app_app_beta".shared_kv');
    expect(sql).not.toContain('app_app_voting');
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
// + the per-app quota. See the appendValueInput note in apps-shared.router.ts.
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

  it('does NOT run `data` through the content-safety belt (a "bad" string in data is stored, not rejected)', async () => {
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
    const auditedPrompt = String((mockAuditPromptServer.mock.calls[0][0] as { prompt: string }).prompt);
    expect(auditedPrompt).toContain('clean title');
    expect(auditedPrompt).not.toContain('13 year old girl');
    const stored = JSON.parse(String((findInsert()![1] as unknown[])[2])) as { data?: { note?: string } };
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

  it('counts `data` bytes toward the per-app quota', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    // usedBytes is 50 bytes under the app quota; a data blob larger than that pushes
    // usedBytes + byteSize over APP_QUOTA_BYTES → 'app quota exceeded' (proving the
    // data bytes are included in byteSize).
    const APP_QUOTA_BYTES = 50 * 1024 * 1024;
    mockPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('author_user_id') && sql.includes('count(*)'))
        return { rows: [{ n: '0' }], rowCount: 1 };
      if (sql.includes('.quota'))
        return {
          rows: [{ used_bytes: String(APP_QUOTA_BYTES - 50), row_count: '0' }],
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
    const stored = JSON.parse(String((findInsert()![1] as unknown[])[2])) as Record<string, unknown>;
    expect(stored).toEqual({ title: 'plain' });
    expect('data' in stored).toBe(false);
  });
});
