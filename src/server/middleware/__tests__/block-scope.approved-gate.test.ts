import { beforeEach, describe, expect, it, vi } from 'vitest';
// Setup-order import: installs the ~/env/server mock with the real test RSA keypair
// BEFORE block-token.service evaluates env at module load (same posture as the sibling
// real-JWT suites).
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * The APPROVED-STATUS gate in `withBlockScope`, end to end over a real minted RS256
 * block JWT and the real middleware. `suspended-app-rest-refusal.test.ts` proves two real
 * ROUTES inherit it; this file is about the gate's own behaviour: which verdicts it
 * produces, what each one returns, where it sits relative to revocation, and the one
 * exemption.
 *
 * ONLY the DB seam is mocked (`dbRead.appBlock.findUnique`) plus the two upstream
 * conditions that would otherwise refuse first (the runtime flag, revocation). The gate
 * itself — `resolveRestApprovalVerdict` — runs for real, which is what makes the dev
 * exemption below a claim about the code rather than about a stub.
 */

const { isFliptMock, isRevokedMock } = vi.hoisted(() => ({
  isFliptMock: vi.fn(async (flag: string) => flag === 'app-blocks-runtime-enabled'),
  isRevokedMock: vi.fn(async () => false),
}));

vi.mock('~/server/flipt/client', () => ({ isFlipt: isFliptMock }));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: isRevokedMock },
}));
// Only the refusal emitter is replaced; everything else in the metrics module (the RED
// counters the middleware also touches) stays real.
const { recordRefusalMock } = vi.hoisted(() => ({ recordRefusalMock: vi.fn() }));
vi.mock('~/server/metrics/app-block-runtime.metrics', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  recordBlockRestApprovalRefusal: recordRefusalMock,
}));

import { dbMock } from '~/__tests__/mocks';
import { withBlockScope } from '../block-scope.middleware';
import { resolveRestApprovalVerdict } from '~/server/services/blocks/block-approval.service';
import { BlockTokenService } from '~/server/services/block-token.service';

/**
 * `~/server/db/client` is mocked GLOBALLY by `~/__tests__/setup` (see
 * `docs/testing/shared-module-mocks.md`) — a per-file `vi.mock` of it is a guarded
 * specifier and would fail `no-direct-shared-module-mock`. Behaviour is declared through
 * the canonical handle instead. Aliased here because this suite asserts on the call, not
 * only on the return value.
 */
const findUniqueMock = dbMock.dbRead.appBlock.findUnique;

const APP_ID = 'app_gate';
const BLOCK_ID = 'blk_gate';
const SCOPE = 'user:read:self';

async function mint(opts: { dev?: boolean } = {}): Promise<string> {
  const { token } = await BlockTokenService.sign({
    userId: 42,
    blockId: BLOCK_ID,
    appId: APP_ID,
    appBlockId: 'apb_gate',
    blockInstanceId: 'bki_gate',
    scopes: [SCOPE],
    ctx: {},
    ...(opts.dev ? { dev: true } : {}),
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

async function drive(token: string) {
  const handler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
    res.status(200).json({ via: 'handler' });
  });
  const route = withBlockScope(handler as never, { endpoint: 'me', requiredScope: SCOPE });
  const res = makeRes();
  await route(makeReq(token) as never, res as never);
  return { handler, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` does not reach the hybrid-proxy nodes the canonical db mock is built
  // from, so the previous test's `mockResolvedValue`/`mockRejectedValue` would otherwise
  // survive into the next one.
  findUniqueMock.mockReset();
  isFliptMock.mockImplementation(async (flag: string) => flag === 'app-blocks-runtime-enabled');
  isRevokedMock.mockImplementation(async () => false);
});

describe('resolveRestApprovalVerdict — the predicate on its own', () => {
  const claims = {
    appId: APP_ID,
    blockId: BLOCK_ID,
  } as Parameters<typeof resolveRestApprovalVerdict>[0];

  it('approved → ok', async () => {
    findUniqueMock.mockResolvedValue({ status: 'approved' });
    expect(await resolveRestApprovalVerdict(claims)).toBe('ok');
  });

  /**
   * EVERY non-approved status, not just `suspended`. The predicate is written as
   * `status === 'approved'` rather than `status !== 'suspended'`, and that difference is
   * the whole point: an app that never finished review, one an owner unpublished, and one
   * a moderator took down are three different rows and one rule. A `!== 'suspended'`
   * spelling would pass a `suspended`-only test and serve the other three.
   */
  it.each(['suspended', 'pending', 'rejected', 'deprecated', 'ephemeral'])(
    '%s → not_approved',
    async (status) => {
      findUniqueMock.mockResolvedValue({ status });
      expect(await resolveRestApprovalVerdict(claims)).toBe('not_approved');
    }
  );

  it('no row → not_found (distinct from not_approved — it is the false-positive channel)', async () => {
    findUniqueMock.mockResolvedValue(null);
    expect(await resolveRestApprovalVerdict(claims)).toBe('not_found');
  });

  it('the read throws → lookup_failed, i.e. FAIL-CLOSED (never `ok`)', async () => {
    findUniqueMock.mockRejectedValue(new Error('replica unreachable'));
    expect(await resolveRestApprovalVerdict(claims)).toBe('lookup_failed');
  });

  it('keys the lookup on the TOKEN CLAIMS, never on anything the caller sent', async () => {
    findUniqueMock.mockResolvedValue({ status: 'approved' });
    await resolveRestApprovalVerdict(claims);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    // Whole normalised argument, not a partial match on one field: the `where` shape IS
    // the security-relevant part, and a `toMatchObject` would accept a widened select or
    // a second, looser `where` key alongside it.
    expect(findUniqueMock.mock.calls[0][0]).toEqual({
      where: { appId_blockId: { appId: APP_ID, blockId: BLOCK_ID } },
      select: { status: true },
    });
  });

  it('a dev token is exempt AND does not even read the DB', async () => {
    findUniqueMock.mockResolvedValue({ status: 'suspended' });
    expect(await resolveRestApprovalVerdict({ ...claims, dev: true })).toBe('dev_exempt');
    // The second half is what pins the exemption as a SHORT-CIRCUIT rather than a
    // post-hoc override — and it is also the cost claim in the docblock (a dev token
    // skips the replica read).
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  /**
   * 🔴 THE EXEMPTION IS `=== true`, NOT TRUTHINESS, and this is the half a reviewer
   * would not think to write. `verifyBlockToken` already rejects a non-boolean `dev`
   * outright, so a string can't reach here through the real path — but the predicate is
   * exported and reachable from the shared-storage resolvers' neighbourhood, and a
   * truthy check would turn any future non-boolean into a silent exemption.
   */
  it.each([undefined, false, 0, '', 'true', 1, {}])(
    'dev=%p is NOT exempt — the check is `=== true`',
    async (dev) => {
      findUniqueMock.mockResolvedValue({ status: 'suspended' });
      expect(await resolveRestApprovalVerdict({ ...claims, dev } as typeof claims)).toBe(
        'not_approved'
      );
    }
  );
});

describe('withBlockScope — the gate on the real request path', () => {
  it('APPROVED: the wrapped handler runs', async () => {
    findUniqueMock.mockResolvedValue({ status: 'approved' });
    const { handler, res } = await drive(await mint());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('SUSPENDED: 403 with the gate’s own body, and the handler never runs', async () => {
    findUniqueMock.mockResolvedValue({ status: 'suspended' });
    const { handler, res } = await drive(await mint());
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'app block is not approved' });
  });

  it('NO ROW: 404, and the handler never runs', async () => {
    findUniqueMock.mockResolvedValue(null);
    const { handler, res } = await drive(await mint());
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'app block not found' });
  });

  it('LOOKUP FAILURE: 503, and the handler never runs — fail CLOSED, unlike revocation', async () => {
    findUniqueMock.mockRejectedValue(new Error('replica unreachable'));
    const { handler, res } = await drive(await mint());
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'app block status unavailable' });
  });

  /**
   * The posture COMPARISON, narrowed to what this file can actually witness.
   *
   * 🔴 The first version of this test mocked `isRevoked` to REJECT and asserted the
   * request still succeeded — and it failed, because it was a claim about a step the mock
   * had replaced. Revocation's fail-open lives INSIDE the primitive
   * (`block-revocation.service.ts:40` — `catch { return false }`), not in the middleware,
   * so a stub that throws is not a Redis incident; it is a broken primitive, and the
   * middleware rightly does not paper over it.
   *
   * What IS checkable here, and what the contrast actually rests on: the middleware adds
   * NO error handling of its own around revocation (a throw propagates), while the
   * approval gate catches and converts. The two postures therefore live in different
   * places — one in the primitive, one in the gate — and cannot be "made consistent" by
   * editing this middleware, which is the misreading worth guarding against.
   */
  it('the middleware adds NO fail-open of its own around revocation — the throw propagates', async () => {
    isRevokedMock.mockRejectedValue(new Error('primitive is broken'));
    findUniqueMock.mockResolvedValue({ status: 'approved' });
    const handler = vi.fn();
    const route = withBlockScope(handler as never, { endpoint: 'me', requiredScope: SCOPE });
    await expect(route(makeReq(await mint()) as never, makeRes() as never)).rejects.toThrow(
      'primitive is broken'
    );
    expect(handler).not.toHaveBeenCalled();
  });

  /**
   * ORDER. A revoked AND suspended instance must report REVOCATION — the cheap Redis
   * check runs first, and the DB read is not paid at all. Asserting the call count is
   * what makes this an order claim rather than a message-text coincidence: both
   * refusals are 403, so the status alone cannot tell them apart.
   */
  it('revoked AND suspended reports REVOCATION, and never reaches the DB read', async () => {
    isRevokedMock.mockResolvedValue(true);
    findUniqueMock.mockResolvedValue({ status: 'suspended' });
    const { handler, res } = await drive(await mint());
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'block instance revoked' });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  /**
   * 🔴 THE CASE THAT IS EASY NOT TO THINK OF, and the one a mutation sweep found nothing
   * else covering: "any valid block token" mode, where `requiredScope` is OMITTED.
   *
   * Four of the thirteen wrapped routes run in that mode (`blocks/models`,
   * `blocks/images`, `blocks/tools`, `blocks/generation-resources`), and the middleware
   * skips BOTH the scope check and `enforceContextBinding` for them — so they are the
   * routes with the thinnest authority surface, and the ones a gate nested one line too
   * far down (inside `if (opts.requiredScope !== undefined)`) would silently exempt.
   * Every other case in this file passes a `requiredScope`, so that mutation survives all
   * of them.
   */
  it('SUSPENDED in "any valid block token" mode (no requiredScope) is refused too', async () => {
    findUniqueMock.mockResolvedValue({ status: 'suspended' });
    const handler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
      res.status(200).json({ via: 'handler' });
    });
    // No `requiredScope` — the catalog-endpoint shape.
    const route = withBlockScope(handler as never, { endpoint: 'models' });
    const res = makeRes();
    await route(makeReq(await mint()) as never, res as never);

    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'app block is not approved' });
  });

  /**
   * 🔴 THE MODERATOR REVIEW SANDBOX, which is the reason the exemption exists and the
   * thing a gate without one would break. A run-for-real review token is `dev: true`, and
   * review is the ONE surface that must work on a non-approved app.
   */
  it('a DEV token on a SUSPENDED app still runs — the review sandbox is not broken', async () => {
    findUniqueMock.mockResolvedValue({ status: 'suspended' });
    const { handler, res } = await drive(await mint({ dev: true }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});

/**
 * The counter is what makes "ship it where it can be watched before it is relied upon"
 * a real property rather than an intention, and its VALUE is in the reason split:
 * `not_approved` is the gate working, `not_found` is a healthy app being refused. An
 * emitter that fired the wrong reason — or fired on the happy path — would make the
 * series say the opposite of what an operator would read it as.
 */
describe('the refusal counter is emitted, once, with the right reason', () => {
  it.each([
    [{ status: 'suspended' }, 'not_approved'],
    [null, 'not_found'],
  ])('%p → reason %s', async (row, reason) => {
    findUniqueMock.mockResolvedValue(row);
    await drive(await mint());
    expect(recordRefusalMock.mock.calls).toEqual([[reason]]);
  });

  it('a lookup failure → reason lookup_failed', async () => {
    findUniqueMock.mockRejectedValue(new Error('replica unreachable'));
    await drive(await mint());
    expect(recordRefusalMock.mock.calls).toEqual([['lookup_failed']]);
  });

  it('NEGATIVE CONTROL — an APPROVED app emits nothing', async () => {
    findUniqueMock.mockResolvedValue({ status: 'approved' });
    await drive(await mint());
    expect(recordRefusalMock).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL — a REVOKED instance is not counted as an approval refusal', async () => {
    // Revocation is a different signal with a different meaning and a different owner.
    // Counting it here would inflate the series an operator uses to decide whether the
    // approval gate is misbehaving.
    isRevokedMock.mockResolvedValue(true);
    findUniqueMock.mockResolvedValue({ status: 'suspended' });
    await drive(await mint());
    expect(recordRefusalMock).not.toHaveBeenCalled();
  });
});
