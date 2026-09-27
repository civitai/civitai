import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/setup';
// Type-only namespace import, named up here: an inline `typeof import('…')` is rejected by
// @typescript-eslint/consistent-type-imports. Erased at compile time, so it does NOT load the
// module the factory below replaces.
import type * as ConsentRevocationModule from '~/server/services/blocks/consent-revocation.service';

/**
 * PER-SCOPE CONSENT REVOCATION ON THE **tRPC BRIDGE** — the half the first cut left open.
 *
 * ## Why this file exists
 *
 * The marker was first wired into `withBlockScope` only, and asked one question: "is the
 * ROUTE's declared `requiredScope` revoked?". Review enumerated every `requiredScope:` under
 * `src/pages/api` and found that of the six consent-gated scopes, only four are ever declared
 * by a route. The two that are not are the two most sensitive:
 *
 *   - `posts:write:self` — authorized HERE, by `authorizeBlockPostRequest`'s
 *     `claims.scopes.includes('posts:write:self')`. The REST middleware is never on that path.
 *     The repo calls this "the first block scope that writes PUBLIC, feed-visible,
 *     reward-earning content under the VIEWER'S name".
 *   - `collections:read:private` — an in-handler sub-check under a route declaring the
 *     consent-EXEMPT `collections:read:self`.
 *
 * `buzz:read:self` and `user:read:self` are additionally read off `claims.scopes` by several
 * bridge procs, so those leaked the viewer's balance and account attributes for up to a token
 * lifetime after a revoke.
 *
 * ## What is pinned
 *
 * That `authorizeBlockBridgeToken` returns claims with the revoked scopes REMOVED — because
 * every bridge proc authorizes off `claims.scopes.includes(...)`, so one strip at this seam is
 * what makes all ~20 of them honour the revoke with no per-proc list to keep current. The
 * procs then refuse with their own existing "block lacks <scope> scope".
 *
 * RED at `a8b75427f5` (the pre-review commit): the bridge consulted no marker at all, so every
 * arm below returned the full scope set.
 */

const { mockVerifyBlockToken, mockIsRevoked, lookupMock, mockApprovalVerdict, recordMock } =
  vi.hoisted(() => ({
    mockVerifyBlockToken: vi.fn(),
    mockIsRevoked: vi.fn(async () => false),
    lookupMock: vi.fn<
      (opts: {
        userId: number;
        appBlockId: string;
      }) => Promise<
        { kind: 'none' } | { kind: 'revoked'; scopes: Set<string> } | { kind: 'unavailable' }
      >
    >(async () => ({ kind: 'none' })),
    mockApprovalVerdict: vi.fn(async () => 'ok'),
    recordMock: vi.fn(),
  }));

vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  verifyBlockToken: mockVerifyBlockToken,
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: mockIsRevoked },
}));
vi.mock('~/server/services/blocks/block-approval.service', () => ({
  resolveAppBlockApprovalVerdict: mockApprovalVerdict,
}));
/**
 * 🔴 ONLY THE REDIS-TOUCHING CLASS IS REPLACED; THE THREE PURE HELPERS STAY REAL. The service
 * under test imports `shouldConsultMarker`, `revokedScopesForToken` and `applyRevocations` from
 * this same specifier, and they hold the decisions worth exercising: which tokens are consulted
 * at all, what "unavailable" means, and what a strip leaves behind.
 */
vi.mock('~/server/services/blocks/consent-revocation.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  ConsentRevocation: { lookup: lookupMock },
}));
vi.mock('~/server/metrics/app-block-runtime.metrics', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  recordBlockConsentRevocationRefusal: recordMock,
}));

import { authorizeBlockBridgeToken } from '../block-bridge-auth.service';

const USER_ID = 4242;
const APP_BLOCK_ID = 'apb_bridge';
const POSTS = 'posts:write:self';
const BUZZ = 'buzz:read:self';
/** Consent-EXEMPT — signed without a grant, so no marker can ever name it. */
const EXEMPT = 'models:read:self';

function claims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: `user:${USER_ID}`,
    iat: 0,
    exp: 0,
    jti: 'jti',
    blockId: 'blk',
    appId: 'app',
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: 'bki_bridge',
    ctx: {},
    scopes: [POSTS, BUZZ, EXEMPT],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsRevoked.mockImplementation(async () => false);
  mockApprovalVerdict.mockImplementation(async () => 'ok');
  lookupMock.mockImplementation(async () => ({ kind: 'none' }));
  mockVerifyBlockToken.mockResolvedValue(claims());
});

describe('authorizeBlockBridgeToken strips revoked scopes', () => {
  /**
   * 🔴 THE CENTRAL CLAIM. `posts:write:self` is authorized on this surface and nowhere else, so
   * this is the arm that makes revoking it mean anything.
   *
   * MUTATION THAT MUST KILL IT: delete the `ConsentRevocation` block from
   * `authorizeBlockBridgeToken`.
   */
  it('removes a revoked scope from the claims it returns', async () => {
    lookupMock.mockResolvedValue({ kind: 'revoked', scopes: new Set([POSTS]) });
    const out = await authorizeBlockBridgeToken('tok');
    expect(
      out.scopes,
      'the bridge returned the revoked scope. Every proc authorizes off ' +
        '`claims.scopes.includes(...)`, so `posts:write:self` — the one scope that publishes ' +
        'public content under the viewer’s name — would still be granted for the rest of the ' +
        'token’s life.'
    ).toEqual([BUZZ, EXEMPT]);
  });

  /**
   * 🔴 THE CONTROL. Same token, same fixture, nothing revoked ⇒ the full set comes back. Without
   * it, a service that always returned an empty scope list would pass the arm above.
   */
  it('CONTROL: returns the full set when nothing is revoked', async () => {
    lookupMock.mockResolvedValue({ kind: 'none' });
    const out = await authorizeBlockBridgeToken('tok');
    expect(out.scopes).toEqual([POSTS, BUZZ, EXEMPT]);
  });

  it('strips several scopes at once and keeps the rest', async () => {
    lookupMock.mockResolvedValue({ kind: 'revoked', scopes: new Set([POSTS, BUZZ]) });
    const out = await authorizeBlockBridgeToken('tok');
    expect(out.scopes).toEqual([EXEMPT]);
  });

  /**
   * 🔴 FAILS CLOSED, and NOT by stripping the exempt scope. `unavailable` names every REVOKABLE
   * scope the token carries; removing `models:read:self` as well would refuse traffic no revoke
   * could ever have touched — a self-inflicted outage on a population the feature does not
   * apply to.
   *
   * MUTATION THAT MUST KILL IT: make `revokedScopesForToken`'s `unavailable` arm return
   * `new Set()` (fail open) or `new Set(scopes)` (strip the exempt one too).
   */
  it('FAILS CLOSED on an unavailable marker, keeping only the exempt scope', async () => {
    lookupMock.mockResolvedValue({ kind: 'unavailable' });
    const out = await authorizeBlockBridgeToken('tok');
    expect(out.scopes).toEqual([EXEMPT]);
  });

  it('asks about the token’s own user and app', async () => {
    await authorizeBlockBridgeToken('tok');
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(lookupMock.mock.calls[0][0]).toEqual({ userId: USER_ID, appBlockId: APP_BLOCK_ID });
  });

  it('emits one counter per scope actually removed, and none when nothing is', async () => {
    lookupMock.mockResolvedValue({ kind: 'revoked', scopes: new Set([POSTS, BUZZ]) });
    await authorizeBlockBridgeToken('tok');
    expect(recordMock.mock.calls.map((c) => c[1]).sort()).toEqual([BUZZ, POSTS].sort());
    expect(recordMock.mock.calls.every((c) => c[0] === 'bridge')).toBe(true);

    recordMock.mockClear();
    lookupMock.mockResolvedValue({ kind: 'none' });
    await authorizeBlockBridgeToken('tok');
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe('the bridge skips the read when it cannot matter', () => {
  /**
   * An ANON token has no (user, app) pair, so no marker can exist for it — and the skip keeps
   * that population out of the fail-closed availability coupling.
   */
  it('does not consult the marker for an anon subject', async () => {
    mockVerifyBlockToken.mockResolvedValue(claims({ sub: 'anon' }));
    const out = await authorizeBlockBridgeToken('tok');
    expect(lookupMock).not.toHaveBeenCalled();
    expect(out.scopes).toEqual([POSTS, BUZZ, EXEMPT]);
  });

  /**
   * A token carrying ONLY consent-exempt scopes cannot be affected by any marker:
   * `blocks.revokeScopes` refuses to record a suppression for an exempt scope, and
   * `partitionByConsent` signs them without consulting the grant at all. Measured at 20 of the
   * 29 scope-bound REST routes; the same argument holds per-token here.
   */
  it('does not consult the marker for an all-exempt token', async () => {
    mockVerifyBlockToken.mockResolvedValue(claims({ scopes: [EXEMPT, 'apps:storage:read'] }));
    await authorizeBlockBridgeToken('tok');
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe('the strip runs AFTER the earlier gates', () => {
  /**
   * A revoked INSTANCE still wins, with its own message — the consent strip must not turn a
   * refusal into a served-but-narrowed request.
   */
  it('a revoked instance still throws, and the marker is not consulted', async () => {
    mockIsRevoked.mockResolvedValue(true);
    lookupMock.mockResolvedValue({ kind: 'revoked', scopes: new Set([POSTS]) });
    await expect(authorizeBlockBridgeToken('tok')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'block instance revoked',
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  /** A non-approved app still throws, ahead of any strip. */
  it('a non-approved app still throws', async () => {
    mockApprovalVerdict.mockResolvedValue('not_approved');
    lookupMock.mockResolvedValue({ kind: 'revoked', scopes: new Set([POSTS]) });
    await expect(authorizeBlockBridgeToken('tok')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('SEAM: through the REAL primitive', () => {
  /**
   * The arms above replace `ConsentRevocation` at the service boundary, which is right for
   * asking what the service ASKS and what it DOES with an answer — and structurally blind to the
   * primitive's own error posture. This block routes through the real `lookup` over mocked
   * Redis, so flipping that `catch` is visible here.
   */
  async function useRealPrimitive() {
    const actual = await vi.importActual<typeof ConsentRevocationModule>(
      '~/server/services/blocks/consent-revocation.service'
    );
    lookupMock.mockImplementation((opts) => actual.ConsentRevocation.lookup(opts));
  }

  it('a Redis THROW strips every revokable scope', async () => {
    const { redisMock } = await import('~/__tests__/mocks/redis.mock');
    await useRealPrimitive();
    redisMock.redis.get.mockRejectedValue(new Error('connection reset'));
    const out = await authorizeBlockBridgeToken('tok');
    expect(out.scopes).toEqual([EXEMPT]);
  });

  it('CONTROL: a marker MISS returns the full set', async () => {
    const { redisMock } = await import('~/__tests__/mocks/redis.mock');
    await useRealPrimitive();
    redisMock.redis.get.mockResolvedValue(null);
    const out = await authorizeBlockBridgeToken('tok');
    expect(out.scopes).toEqual([POSTS, BUZZ, EXEMPT]);
  });

  it('a real marker strips exactly what it lists', async () => {
    const { redisMock } = await import('~/__tests__/mocks/redis.mock');
    await useRealPrimitive();
    redisMock.redis.get.mockResolvedValue(JSON.stringify([BUZZ]));
    const out = await authorizeBlockBridgeToken('tok');
    expect(out.scopes).toEqual([POSTS, EXEMPT]);
  });
});
