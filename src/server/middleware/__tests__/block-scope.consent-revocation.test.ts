import { beforeEach, describe, expect, it, vi } from 'vitest';
// Setup-order import: installs the ~/env/server mock with the real test RSA keypair BEFORE
// block-token.service evaluates env at module load (same posture as the sibling real-JWT
// suites in this directory).
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';
// Type-only NAMESPACE import, named up here: an inline `typeof import('…')` is rejected by
// @typescript-eslint/consistent-type-imports (same posture as blocks.router.scopeEnforcement's
// BlockGenIdempotency import). Erased at compile time, so it does NOT load the module the
// factory below replaces — `vi.importActual` is what reaches the real one, deliberately.
import type * as ConsentRevocationModule from '~/server/services/blocks/consent-revocation.service';

/**
 * THE PER-SCOPE CONSENT-REVOCATION GATE in `withBlockScope`, end to end over a real minted
 * RS256 block JWT and the real middleware.
 *
 * ## What this closes, and why the grant table alone could not
 *
 * `app_user_scope_grants` is read at MINT. This path then trusts `claims.scopes` verbatim —
 * only the hub-OAuth branch re-derives from the grant — so a revoke written to Postgres is
 * INVISIBLE to a token that was already signed, for up to its remaining life (900s default,
 * 300s settings-scoped, 4h dev). `BlockRevocation` cannot cover it either: that control is
 * keyed per-`blockInstanceId` and knows nothing about the consent ledger.
 *
 * ## Only the two seams are mocked
 *
 * `ConsentRevocation` (the Redis marker) and the two upstream conditions that would
 * otherwise refuse first — the runtime flag and `BlockRevocation.isRevoked`. The middleware,
 * the token verification, the ORDER of the gates and the response bodies all run for real,
 * which is what makes the fail-closed arm a claim about the code rather than about a stub.
 *
 * ## RED/GREEN
 *
 * Red at `origin/main` by absence: `~/server/services/blocks/consent-revocation.service`
 * does not exist there, so the file cannot import and vitest reports "no tests" rather than
 * a failure. Each arm therefore names the ISOLATED MUTATION that must kill it, and those
 * were run.
 */

/** The one argument shape `ConsentRevocation.isScopeRevoked` takes. */
type ConsentRevokedQuery = { userId: number; appBlockId: string; scope: string };

const { isFliptMock, isRevokedMock, isScopeRevokedMock } = vi.hoisted(() => ({
  isFliptMock: vi.fn(async (flag: string) => flag === 'app-blocks-runtime-enabled'),
  isRevokedMock: vi.fn(async () => false),
  // 🔴 THE SIGNATURE IS DECLARED AS A GENERIC, not inferred from a zero-arg arrow. Without it
  // vitest types `mock.calls` as `[]` and `mock.calls[0][0]` is a TS2493 — and that is exactly
  // the assertion pinning WHAT the middleware asks about, i.e. the one this file cannot do
  // without. Declared on `vi.fn<…>` rather than as an unused `_opts` parameter, which lints.
  isScopeRevokedMock: vi.fn<(opts: ConsentRevokedQuery) => Promise<boolean>>(async () => false),
}));

vi.mock('~/server/flipt/client', () => ({ isFlipt: isFliptMock }));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: isRevokedMock },
}));
/**
 * The consent marker. Replaced at the SERVICE boundary rather than by stubbing Redis,
 * because the primitive's own behaviour — including its fail-closed `catch` — is covered in
 * `blocks/__tests__/consent-revocation.service.test.ts`. What this file is about is whether
 * the middleware ASKS, what it asks about, and what it does with the answer.
 *
 * 🔴 The "Redis is down" arm below therefore makes the MOCK behave as the real primitive
 * does (resolve `true`) rather than throwing — and there is a separate structural test at
 * the bottom asserting the middleware does not wrap the call in its own `try`, which is the
 * only way this file could be fooled about the fail-closed posture.
 */
vi.mock('~/server/services/blocks/consent-revocation.service', () => ({
  ConsentRevocation: { isScopeRevoked: isScopeRevokedMock },
}));

import { readFileSync } from 'fs';
import path from 'path';
import { dbMock } from '~/__tests__/mocks';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { withBlockScope } from '../block-scope.middleware';
import { BlockTokenService } from '~/server/services/block-token.service';

const APP_ID = 'app_consent';
const BLOCK_ID = 'blk_consent';
const APP_BLOCK_ID = 'apb_consent';
const SCOPE = 'ai:write:budgeted';
const USER_ID = 4242;

const findUniqueMock = dbMock.dbRead.appBlock.findUnique;

async function mint(opts: { userId?: number | null } = {}): Promise<string> {
  const { token } = await BlockTokenService.sign({
    // `userId: null` mints the anon subject, which is one of the two documented skips.
    userId: opts.userId === undefined ? USER_ID : opts.userId,
    blockId: BLOCK_ID,
    appId: APP_ID,
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: 'bki_consent',
    scopes: [SCOPE],
    ctx: {},
    buzzBudget: 100,
  } as Parameters<typeof BlockTokenService.sign>[0]);
  return token;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send() {
      return this;
    },
    end() {
      return this;
    },
    setHeader() {
      return this;
    },
    removeHeader() {
      return undefined;
    },
    writeHead() {
      return this;
    },
    getHeader() {
      return undefined;
    },
    on() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown };
}

function makeReq(token: string): NextApiRequest {
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    query: {},
    url: '/api/v1/blocks/me',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

/** Drives the real middleware. `requiredScope: null` exercises any-token mode. */
async function drive(token: string, requiredScope: string | null = SCOPE) {
  const handler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
    res.status(200).json({ via: 'handler' });
  });
  const route = withBlockScope(
    handler as never,
    {
      endpoint: 'me',
      ...(requiredScope === null ? {} : { requiredScope }),
    } as never
  );
  const res = makeRes();
  await route(makeReq(token) as never, res as never);
  return { handler, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` does not reach the hybrid-proxy nodes the canonical db mock is built
  // from, so a previous test's resolved value would otherwise survive.
  findUniqueMock.mockReset();
  findUniqueMock.mockResolvedValue({ status: 'approved' });
  isFliptMock.mockImplementation(async (flag: string) => flag === 'app-blocks-runtime-enabled');
  isRevokedMock.mockImplementation(async () => false);
  isScopeRevokedMock.mockImplementation(async () => false);
  // Reset between tests so the SEAM block's per-test Redis behaviour cannot leak into the
  // boundary-mocked blocks (where a rejected `get` would be an unhandled rejection in a
  // test that never touches Redis).
  redisMock.redis.get.mockReset();
  redisMock.redis.get.mockResolvedValue(null);
});

describe('a token carrying a now-revoked scope is refused', () => {
  /**
   * 🔴 THE CENTRAL MIDDLEWARE CLAIM: 403 with `code: 'consent_revoked'`, and the wrapped
   * handler never runs.
   *
   * MUTATION THAT MUST KILL IT: delete the `ConsentRevocation.isScopeRevoked` block from
   * `withBlockScope`.
   */
  it('403s with code consent_revoked and does not reach the handler', async () => {
    isScopeRevokedMock.mockResolvedValue(true);
    const { handler, res } = await drive(await mint());
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'consent_revoked' });
    // The human string names the scope, so an author reading a log knows WHICH permission.
    expect((res.body as { error: string }).error).toContain(SCOPE);
    expect(
      handler,
      'the wrapped handler ran despite a revoked scope — the gate returned without ' +
        'refusing, or it sits AFTER the handler dispatch'
    ).not.toHaveBeenCalled();
  });

  /**
   * 🔴 THE CONTROL, and it is what makes the test above attributable. Same token, same
   * route, marker says NOT revoked ⇒ the request is SERVED. Without it, a middleware that
   * 403'd unconditionally would pass every other assertion here.
   */
  it('CONTROL: with no revocation the same request is served', async () => {
    isScopeRevokedMock.mockResolvedValue(false);
    const { handler, res } = await drive(await mint());
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 IT ASKS ABOUT THE RIGHT THREE THINGS. A gate that asked about the wrong scope, or
   * keyed on something other than (subject user, token's appBlockId), would refuse the
   * wrong requests — and every test above would still pass, because the mock answers
   * whatever it is asked.
   */
  it('asks about the ROUTE’s required scope, the token’s user and the token’s app', async () => {
    isScopeRevokedMock.mockResolvedValue(false);
    await drive(await mint());
    expect(isScopeRevokedMock).toHaveBeenCalledTimes(1);
    expect(isScopeRevokedMock.mock.calls[0][0]).toEqual({
      userId: USER_ID,
      appBlockId: APP_BLOCK_ID,
      scope: SCOPE,
    });
  });

  /**
   * 🔴 FAIL CLOSED. The primitive resolves `true` on a Redis error (its own suite pins
   * that), and the middleware must honour it as a refusal rather than, say, catching and
   * serving.
   *
   * MUTATION THAT MUST KILL IT: wrap the middleware's `isScopeRevoked` call in
   * `try { … } catch { /* serve *\/ }`, or flip the primitive's `catch` to `return false`.
   */
  it('refuses when the marker read is UNAVAILABLE (fail closed)', async () => {
    // What the real primitive does on a Redis incident.
    isScopeRevokedMock.mockResolvedValue(true);
    const { res } = await drive(await mint());
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'consent_revoked' });
  });

  /**
   * And the structural half of the same claim, because the behavioural test above cannot
   * distinguish "honours the refusal" from "swallowed a throw and happened to refuse". If
   * the middleware wrapped the call in its own `try`, a THROWN Redis error would be served.
   */
  it('does not wrap the marker read in its own catch', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../block-scope.middleware.ts'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const at = source.indexOf('ConsentRevocation.isScopeRevoked');
    expect(at, 'the middleware no longer calls the consent marker at all').toBeGreaterThan(-1);
    // Look at the 600 characters around the call. A `catch` there would be the fail-open
    // this gate must not have. (`BlockRevocation.isRevoked`'s fail-open lives INSIDE the
    // primitive, not at the call site, so no legitimate `catch` belongs here.)
    const around = source.slice(Math.max(0, at - 300), at + 300);
    expect(
      /\bcatch\b/.test(around),
      'a `catch` appeared around the consent-marker read. This gate must fail CLOSED; a ' +
        'catch here serves a request whose permission the viewer revoked.'
    ).toBe(false);
  });
});

/**
 * 🔴 THE SEAM ARM — THE MIDDLEWARE DRIVEN THROUGH THE **REAL** PRIMITIVE, OVER MOCKED REDIS.
 *
 * Everything above replaces `ConsentRevocation` at the service boundary, which is right for
 * asking what the middleware ASKS and what it DOES with an answer — and structurally blind to
 * the primitive's own error posture. MEASURED: flipping the primitive's `catch` from
 * `return true` to `return false` (the "align it with `BlockRevocation`" cleanup) left this
 * whole file GREEN, 11/11, while breaking the guarantee the file is about. Two components each
 * mutation-swept and audit-clean, broken together, with every fixture scoped to one surface.
 *
 * So this block asks the composed question: Redis throws, the REAL `isScopeRevoked` runs, and
 * the middleware must 403. It is the arm that makes the fail-closed posture attributable to the
 * code rather than to a mock's return value.
 */
describe('SEAM: fail-closed through the real primitive', () => {
  /** Routes the mocked export straight back into the real implementation. */
  async function useRealPrimitive() {
    const actual = await vi.importActual<typeof ConsentRevocationModule>(
      '~/server/services/blocks/consent-revocation.service'
    );
    isScopeRevokedMock.mockImplementation((opts) => actual.ConsentRevocation.isScopeRevoked(opts));
  }

  /**
   * MUTATION THAT MUST KILL IT: change `isScopeRevoked`'s `catch` to `return false` in
   * `blocks/consent-revocation.service.ts`.
   */
  it('a Redis THROW refuses the request', async () => {
    await useRealPrimitive();
    redisMock.redis.get.mockRejectedValue(new Error('connection reset'));
    const { handler, res } = await drive(await mint());
    expect(
      res.statusCode,
      'a Redis error let the request through. The consent marker must fail CLOSED: the ' +
        'viewer asked for this permission to stop being granted and was told it was done.'
    ).toBe(403);
    expect(res.body).toMatchObject({ code: 'consent_revoked' });
    expect(handler).not.toHaveBeenCalled();
  });

  /** A real marker listing the route's scope refuses, end to end over the real JSON shape. */
  it('a real marker listing the scope refuses', async () => {
    await useRealPrimitive();
    redisMock.redis.get.mockResolvedValue(JSON.stringify([SCOPE]));
    const { res } = await drive(await mint());
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'consent_revoked' });
  });

  /**
   * 🔴 THE CONTROL FOR BOTH, and it is what stops this block passing on a middleware that
   * refuses whenever Redis is involved at all. A genuine cache MISS — the overwhelmingly
   * common case — serves.
   */
  it('CONTROL: a marker MISS serves the request', async () => {
    await useRealPrimitive();
    redisMock.redis.get.mockResolvedValue(null);
    const { handler, res } = await drive(await mint());
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  /** And a marker listing a DIFFERENT scope serves — the narrowing, end to end. */
  it('CONTROL: a marker listing a different scope serves', async () => {
    await useRealPrimitive();
    redisMock.redis.get.mockResolvedValue(JSON.stringify(['posts:write:self']));
    const { handler, res } = await drive(await mint());
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('the two documented skips', () => {
  /**
   * ANY-TOKEN MODE (the public catalog routes, `requiredScope` omitted): no scope is being
   * exercised, so there is nothing a per-scope revoke could refuse. Refusing on a token's
   * unrelated revoked scope would break the catalog for a reason the viewer never asked for.
   *
   * 🔴 THE MARKER IS NOT EVEN READ, and asserting that — not just the 200 — is the point:
   * the skip must be upstream of the Redis call, or these routes pay a GET (and the
   * fail-closed availability coupling) for a question that cannot apply to them.
   */
  it('any-token mode does not consult the marker at all', async () => {
    isScopeRevokedMock.mockResolvedValue(true);
    const { handler, res } = await drive(await mint(), null);
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(isScopeRevokedMock).not.toHaveBeenCalled();
  });

  /**
   * ANON SUBJECT: consent is per (user, app) and an anon token has no user, so no marker can
   * exist for it. Same "not even read" assertion, same reason.
   *
   * 🔴 IT ASSERTS THE REQUEST WAS **SERVED**, NOT MERELY THAT THE MARKER WENT UNREAD. "The
   * marker was not consulted" is exactly the observation a token that failed VERIFICATION
   * would also produce — a 401 returns long before this gate — so on its own it is a
   * reassuring zero indistinguishable from a probe wired to nothing. The 200 proves the anon
   * token really reached and passed this gate.
   */
  it('an anon token is served without consulting the marker', async () => {
    isScopeRevokedMock.mockResolvedValue(true);
    const { handler, res } = await drive(await mint({ userId: null }));
    expect(
      res.statusCode,
      `anon request did not reach the handler: ${JSON.stringify(res.body)}`
    ).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(isScopeRevokedMock).not.toHaveBeenCalled();
  });
});

describe('gate ORDER and the sibling 403s', () => {
  /**
   * 🔴 INSTANCE REVOCATION RUNS FIRST, and the two 403s carry DIFFERENT codes. An app that
   * cannot tell "this install went away / the publisher was banned" from "the user withdrew
   * this permission" either keeps retrying something that will never work, or reports a
   * consent problem for what is really a takedown.
   */
  it('a revoked INSTANCE is reported as instance_revoked, not consent_revoked', async () => {
    isRevokedMock.mockResolvedValue(true);
    isScopeRevokedMock.mockResolvedValue(true);
    const { res } = await drive(await mint());
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'instance_revoked' });
    // And the consent marker was never read — the instance check short-circuits, which is
    // one fewer Redis round trip on a request that is refused either way.
    expect(isScopeRevokedMock).not.toHaveBeenCalled();
  });

  /**
   * 🔴 A MISSING SCOPE IS `insufficient_scope`, NOT `consent_revoked`. The distinction is
   * the whole reason for adding machine-readable codes: one is a manifest/approval gap, the
   * other is a user decision with a remedy the host can offer.
   *
   * This drives a route whose `requiredScope` the token does not carry, so the consent gate
   * (which asks about that same scope) answers "not revoked" and the later check refuses.
   */
  it('a scope the token never carried is insufficient_scope', async () => {
    isScopeRevokedMock.mockResolvedValue(false);
    const { handler, res } = await drive(await mint(), 'posts:write:self');
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'insufficient_scope' });
    expect((res.body as { error: string }).error).toContain('posts:write:self');
    expect(handler).not.toHaveBeenCalled();
  });

  /**
   * 🔴 CONSENT REVOCATION RUNS BEFORE THE APPROVED-STATUS GATE, and the reason mirrors the
   * existing instance/approval ordering: the marker is a Redis GET that responds to a USER
   * action within seconds, while the approval check is a DB read. A revoked-AND-suspended
   * app is reported as revoked.
   */
  it('a revoked scope on a SUSPENDED app is reported as consent_revoked', async () => {
    findUniqueMock.mockResolvedValue({ status: 'suspended' });
    isScopeRevokedMock.mockResolvedValue(true);
    const { res } = await drive(await mint());
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'consent_revoked' });
  });

  /**
   * The control for the ordering claim above: with no revocation, the SAME suspended app is
   * refused by the approval gate. Without this, the test above would also pass on a
   * middleware that ignored `status` entirely.
   */
  it('CONTROL: with no revocation a suspended app is refused by the approval gate', async () => {
    findUniqueMock.mockResolvedValue({ status: 'suspended' });
    isScopeRevokedMock.mockResolvedValue(false);
    const { res } = await drive(await mint());
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'app block is not approved' });
  });
});
