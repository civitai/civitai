import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';

/**
 * Handler-level coverage for GET /api/v1/blocks/me — the block-token-authed
 * viewer-identity endpoint. Previously had ZERO tests despite being an authz
 * surface with several fail-closed gates.
 *
 * Asserts the security-sensitive invariants of the inner handler:
 *   - method:   non-GET → 405.
 *   - claims:   missing blockClaims (defense-in-depth) → 401.
 *   - subject:  malformed sub (parseSubjectUserId throws) → 403;
 *               anon sub (parseSubjectUserId → null)      → 403.
 *   - gate:     the App-Blocks kill-switch on the TOKEN subject — an unhydratable
 *               subject → 401, a subject the `app-blocks-enabled` flag does not
 *               admit → 401. Re-asserted on this route because block-token minting
 *               is gated on the same flag but a token minted just before the
 *               subject leaves the audience stays valid for up to ~15min.
 *   - limit:    an over-limit block instance → 429, BEFORE the primary read.
 *   - lookup:   user missing OR soft-deleted → 404 (via dbWrite, NOT the replica,
 *               so a ban during replication lag can't surface as active).
 *   - ban:      bannedAt set → 403 (second line of defense vs. the mint gate).
 *   - happy:    admitted viewer → 200 { id, username, status:'active', buzzBudget }.
 *   - muted:    a muted (non-banned) viewer passes through with status:'muted'.
 *   - budget:   buzzBudget mirrors the JWT claim; absent claim → null.
 *
 * 🔴 THERE USED TO BE A `resolved non-moderator → 403` CASE HERE AND IT IS GONE ON
 * PURPOSE. This route carried a hardcoded `if (!user.isModerator)` while its tRPC twin
 * `blocks.getMyViewer` — whose docblock claimed to mirror it EXACTLY — never did, so
 * the same subject got different answers on the two doors. The Flipt flag is the gate;
 * the literal was dropped and the twin's flag gate + rate limiter added here instead.
 * The two doors are now compared against each other, as behaviour, in
 * `src/server/routers/__tests__/blocks.router.me-parity.test.ts` — this file is the
 * per-door suite and is BY CONSTRUCTION unable to see a divergence between them.
 *
 * withBlockScope is mocked as a passthrough that stamps req.blockClaims (the
 * real token-verify path is covered by block-scope.middleware tests).
 * parseSubjectUserId is a FAITHFUL re-implementation of the real one so the
 * anon / malformed / valid branches are exercised through realistic behavior,
 * not a hand-forced return value.
 */

function createMocks({
  method = 'GET',
  headers = {},
}: {
  method?: string;
  headers?: Record<string, string>;
} = {}) {
  const req = {
    method,
    headers,
    socket: { remoteAddress: '203.0.113.7' },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  } as unknown as Record<string, unknown>;
  let statusCode = 200;
  let payload: unknown = undefined;
  const responseHeaders: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader(key: string, value: string) {
      responseHeaders[key] = value;
    },
    end() {
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
    _getHeaders: () => responseHeaders,
  };
  return { req, res };
}

const { mockGetSessionUser, mockIsAppBlocksEnabled, mockCheckRateLimit } = vi.hoisted(() => ({
  mockGetSessionUser: vi.fn(),
  mockIsAppBlocksEnabled: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

// The inner handler reads `req.blockClaims`; withBlockScope injects it. Point
// claimsBox.claims at the token under test per-case.
const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

class ForbiddenError extends Error {
  readonly status = 403 as const;
}

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
  // Faithful mirror of the real parseSubjectUserId (block-scope.middleware.ts):
  // 'anon' → null, a valid `user:<id>` → the numeric id, anything else THROWS
  // a ForbiddenError. This lets the handler's try/catch (403) AND the null-check
  // (403) branches run against realistic behavior.
  parseSubjectUserId: (sub: string): number | null => {
    if (sub === 'anon') return null;
    if (!/^user:\d+$/.test(sub)) throw new ForbiddenError('malformed sub claim');
    return Number.parseInt(sub.slice('user:'.length), 10);
  },
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (handler: any) => handler }));

// The two dependencies of the SHARED App-Blocks kill-switch
// (`assertAppBlocksEnabledForTokenUser`, `~/server/services/blocks/block-token-access.service`),
// mocked by module specifier so the REAL gate runs against them.
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => mockGetSessionUser(...a) },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: (...a: unknown[]) => mockIsAppBlocksEnabled(...a),
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a),
}));

import handler from '~/pages/api/v1/blocks/me';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockFindUnique = dbMock.dbWrite.user.findUnique;

function fakeClaims(over: Partial<BlockTokenClaims> = {}): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'jti',
    blockId: 'blk',
    appId: 'app',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
    ctx: {},
    scopes: ['user:read:self'],
    buzzBudget: 250,
    ...over,
  } as BlockTokenClaims;
}

const activeViewer = {
  id: 42,
  username: 'viewer',
  bannedAt: null,
  muted: false,
  deletedAt: null,
};

/** What the shared kill-switch hydrates from the self-bound token subject. */
const subjectSessionUser = { id: 42, username: 'viewer', isModerator: false, tier: 'free' };

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockFindUnique.mockResolvedValue(activeViewer);
  mockGetSessionUser.mockResolvedValue(subjectSessionUser);
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

describe('GET /api/v1/blocks/me', () => {
  it('405 for a non-GET method (never reads a user)', async () => {
    const { req, res } = createMocks({ method: 'POST' });
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(405);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('401 when blockClaims is absent (defense-in-depth guard)', async () => {
    claimsBox.claims = undefined;
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('403 when the sub claim is malformed (parseSubjectUserId throws)', async () => {
    claimsBox.claims = fakeClaims({ sub: 'garbage-not-a-user' as never });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect((res._getJSONData() as { error: string }).error).toBe('Invalid subject claim');
    // No DB lookup for a token whose subject can't be parsed.
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('403 for an anonymous token (sub=anon → userId null) — no anon viewer identity', async () => {
    claimsBox.claims = fakeClaims({ sub: 'anon' as never });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect((res._getJSONData() as { error: string }).error).toMatch(/Anonymous block tokens/);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('404 when the resolved user does not exist', async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(404);
    // The lookup is keyed on the SELF-BOUND token subject (42), never client input.
    expect(mockFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 42 } }));
  });

  it('404 when the user is soft-deleted (deletedAt set)', async () => {
    mockFindUnique.mockResolvedValueOnce({ ...activeViewer, deletedAt: new Date() });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(404);
  });

  it('reads from dbWrite (primary), NOT the replica (M1: no stale-active-during-lag leak)', async () => {
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    // The only DB call is the mocked dbWrite.user.findUnique — dbRead is not even
    // provided in the client mock, so a switch to the replica would throw here.
    expect(res._getStatusCode()).toBe(200);
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
  });

  it('401 when the app-blocks-enabled flag does not admit the token subject', async () => {
    // The gate that REPLACED the hardcoded moderator literal. `isModerator` is
    // deliberately NOT what decides here — see the file header.
    mockIsAppBlocksEnabled.mockResolvedValueOnce(false);
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
    expect((res._getJSONData() as { error: string }).error).toBe('Apps are not enabled');
    // Refused BEFORE the primary read.
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('401 when the token subject no longer hydrates (fail-closed, before the flag)', async () => {
    mockGetSessionUser.mockResolvedValueOnce(null);
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
    // The route renders BOTH kill-switch refusals with its own generic literal and does
    // NOT echo the gate's message. Asserted from both sides: the operator-facing text
    // (which is also a compiled-branch watchlist anchor, and must stay unique app-wide)
    // must not reach a third-party block iframe.
    expect((res._getJSONData() as { error: string }).error).toBe('Apps are not enabled');
    expect(JSON.stringify(res._getJSONData())).not.toContain('could not be resolved');
    // The flag is never consulted for a subject we could not resolve — a global eval
    // would answer the flag's BASE value, which a GA flip makes `true`.
    expect(mockIsAppBlocksEnabled).not.toHaveBeenCalled();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('a MODERATOR the flag does not admit is refused — the flag is the gate, not the role', async () => {
    // The direction the old literal could never express: the flag refuses a moderator.
    //
    // ⚠️ THIS CASE DOES NOT SPECIFICALLY GUARD AGAINST THE LITERAL COMING BACK — it varies
    // the SESSION user, while a reintroduced `if (!user.isModerator)` reads the DB ROW.
    // 🔴 An earlier comment here went further and said the mutation is "invisible in this
    // file". That was wrong, and measured: `activeViewer` carries no `isModerator` column,
    // so the reintroduced literal sees `undefined`, refuses EVERY viewer, and reddens FIVE
    // cases here (dbWrite-primary, banned-403, happy-200, muted-200, buzzBudget-null).
    // Understating existing coverage is the direction that gets a guard deleted later.
    // The case that covers it ON PURPOSE is in `blocks.router.me-parity.test.ts`, whose
    // `userRow()` keeps the column on the fixture; measured, the literal reddens its cases
    // A, C and F. This case is kept for what it does assert: the flag beats the role.
    mockGetSessionUser.mockResolvedValueOnce({ ...subjectSessionUser, isModerator: true });
    mockIsAppBlocksEnabled.mockResolvedValueOnce(false);
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(401);
  });

  it('429 when the block instance is over the shared catalog rate limit', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 7 });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(429);
    expect(res._getHeaders()['Retry-After']).toBe('7');
    // Keyed on the stable per-instance id, and refused BEFORE the primary read it
    // exists to bound.
    expect(mockCheckRateLimit).toHaveBeenCalledWith('bki_test');
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('403 when the resolved viewer is banned (bannedAt set) — second line of defense', async () => {
    mockFindUnique.mockResolvedValueOnce({ ...activeViewer, bannedAt: new Date() });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect((res._getJSONData() as { error: string }).error).toBe('banned');
  });

  it('200 with the viewer profile + buzzBudget for an admitted viewer', async () => {
    claimsBox.claims = fakeClaims({ buzzBudget: 250 });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      id: 42,
      username: 'viewer',
      status: 'active',
      buzzBudget: 250,
    });
  });

  it('200 with status:"muted" for a muted (non-banned) viewer — block suppresses write UI', async () => {
    mockFindUnique.mockResolvedValueOnce({ ...activeViewer, muted: true });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect((res._getJSONData() as { status: string }).status).toBe('muted');
  });

  it('surfaces buzzBudget:null when the token carries no ai:write:budgeted budget claim', async () => {
    claimsBox.claims = fakeClaims({ buzzBudget: undefined });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect((res._getJSONData() as { buzzBudget: number | null }).buzzBudget).toBeNull();
  });
});
