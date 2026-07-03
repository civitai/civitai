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
 *   - lookup:   user missing OR soft-deleted → 404 (via dbWrite, NOT the replica,
 *               so a ban during replication lag can't surface as active).
 *   - gate:     resolved non-moderator → 403 (mod-gated until GA — re-asserted
 *               here because a token minted just before demotion stays valid).
 *   - ban:      bannedAt set → 403 (second line of defense vs. the mint gate).
 *   - happy:    active mod → 200 { id, username, status:'active', buzzBudget }.
 *   - muted:    a muted (non-banned) mod passes through with status:'muted'.
 *   - budget:   buzzBudget mirrors the JWT claim; absent claim → null.
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

const { mockFindUnique } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
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

// The handler reads from dbWrite (M1: never the replica) for the ban/mute/deleted
// lookup — mock ONLY that method so no Prisma engine is needed.
vi.mock('~/server/db/client', () => ({
  dbWrite: { user: { findUnique: mockFindUnique } },
}));

import handler from '~/pages/api/v1/blocks/me';

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

const activeMod = {
  id: 42,
  username: 'mod',
  bannedAt: null,
  muted: false,
  deletedAt: null,
  isModerator: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  claimsBox.claims = fakeClaims();
  mockFindUnique.mockResolvedValue(activeMod);
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
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 42 } })
    );
  });

  it('404 when the user is soft-deleted (deletedAt set)', async () => {
    mockFindUnique.mockResolvedValueOnce({ ...activeMod, deletedAt: new Date() });
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

  it('403 when the resolved viewer is NOT a moderator (mod-gated until GA)', async () => {
    mockFindUnique.mockResolvedValueOnce({ ...activeMod, isModerator: false });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect((res._getJSONData() as { error: string }).error).toMatch(/Civitai team/);
  });

  it('403 when the resolved viewer is banned (bannedAt set) — second line of defense', async () => {
    mockFindUnique.mockResolvedValueOnce({ ...activeMod, bannedAt: new Date() });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(403);
    expect((res._getJSONData() as { error: string }).error).toBe('banned');
  });

  it('200 with the viewer profile + buzzBudget for an active mod', async () => {
    claimsBox.claims = fakeClaims({ buzzBudget: 250 });
    const { req, res } = createMocks();
    await handler(req as never, res as never);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      id: 42,
      username: 'mod',
      status: 'active',
      buzzBudget: 250,
    });
  });

  it('200 with status:"muted" for a muted (non-banned) mod — block suppresses write UI', async () => {
    mockFindUnique.mockResolvedValueOnce({ ...activeMod, muted: true });
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
