import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
// Only the verdict emitter is replaced; everything else in the metrics module (the RED
// counters the middleware also touches) stays real.
const { recordVerdictMock } = vi.hoisted(() => ({ recordVerdictMock: vi.fn() }));
vi.mock('~/server/metrics/app-block-runtime.metrics', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  recordBlockRestApprovalVerdict: recordVerdictMock,
}));

import { dbMock } from '~/__tests__/mocks';
import { withBlockScope } from '../block-scope.middleware';
import {
  __resetApprovalLookupFailureLogThrottleForTests,
  resolveRestApprovalVerdict,
} from '~/server/services/blocks/block-approval.service';
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

  /**
   * 🔴 NO ROW IS NOT A TAKEDOWN, SO IT DOES NOT REFUSE. Every moderator takedown leaves a
   * row whose `status` is not `approved`, which means the whole of this gate's value sits
   * in the `not_approved` branch above. A missing row is the opposite shape: a
   * signature-valid token whose `(appId, blockId)` resolves to nothing — a row deleted or
   * re-keyed mid-session, blockId drift, an id-minting bug — i.e. a HEALTHY app, carrying
   * all of the false-positive risk and none of the value. It is OBSERVED (counted + logged)
   * and SERVED.
   *
   * This is the assertion that pins the decision. It was RED before it — the gate answered
   * 404 here — and a regression that reinstates the refusal fails on the handler count
   * first, which is the half that says a healthy app was turned away.
   */
  it('NO ROW: the request is SERVED — the handler runs and answers 200', async () => {
    findUniqueMock.mockResolvedValue(null);
    const { handler, res } = await drive(await mint());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ via: 'handler' });
  });

  it('NO ROW in "any valid block token" mode (no requiredScope) is SERVED too', async () => {
    findUniqueMock.mockResolvedValue(null);
    const handler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
      res.status(200).json({ via: 'handler' });
    });
    const route = withBlockScope(handler as never, { endpoint: 'models' });
    const res = makeRes();
    await route(makeReq(await mint()) as never, res as never);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('LOOKUP FAILURE: 503, and the handler never runs — fail CLOSED, unlike revocation', async () => {
    findUniqueMock.mockRejectedValue(new Error('replica unreachable'));
    const { handler, res } = await drive(await mint());
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'app block status unavailable' });
  });

  /**
   * 🔴 THE OPT-OUT, BOTH ARMS. `lookup_failed` is the one verdict whose response depends on
   * the ROUTE, so a test of either arm alone certifies nothing: the fail-closed case above
   * passes if the option is ignored entirely, and the serve case below passes if the gate
   * stopped refusing on `lookup_failed` everywhere. Only the pair pins that the option is
   * READ and that it changes exactly one thing.
   *
   * The declared set and its rationales live in `no-unguarded-block-rest-token.test.ts`;
   * this file is about what the middleware DOES with the declaration.
   */
  it('LOOKUP FAILURE + `onApprovalLookupFailure: serve`: the request is SERVED', async () => {
    findUniqueMock.mockRejectedValue(new Error('replica unreachable'));
    const handler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
      res.status(200).json({ via: 'handler' });
    });
    // The catalog shape, with the opt-out the four catalog routes now declare.
    const route = withBlockScope(handler as never, {
      endpoint: 'models',
      onApprovalLookupFailure: 'serve',
    });
    const res = makeRes();
    await route(makeReq(await mint()) as never, res as never);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ via: 'handler' });
  });

  /**
   * 🔴 SERVING IS NOT BYPASSING. `v1/models/[id]` is a SCOPED serve route — it declares
   * `requiredScope: 'models:read:self'` AND `onApprovalLookupFailure: 'serve'` — so this
   * combination is live in the tree, not hypothetical, and it is the one a reader is most
   * likely to misread as "the opt-out lets the request through".
   *
   * It does not. The opt-out decides ONE branch of the approval gate; everything after it
   * still runs, including the per-scope authorization check and `enforceContextBinding`. A
   * token missing the scope is still 403 even while the approval status is unknown.
   */
  it('🔴 a SCOPED serve route still enforces its scope while serving a lookup_failed', async () => {
    findUniqueMock.mockRejectedValue(new Error('replica unreachable'));
    const handler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
      res.status(200).json({ via: 'handler' });
    });
    // The live `v1/models/[id]` shape, but demanding a scope the minted token lacks.
    const route = withBlockScope(handler as never, {
      endpoint: 'model_detail',
      requiredScope: 'models:read:self',
      onApprovalLookupFailure: 'serve',
    });
    const res = makeRes();
    await route(makeReq(await mint()) as never, res as never);

    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'missing required scope: models:read:self' });
  });

  /**
   * …and the paired positive: the SAME route with the scope PRESENT does serve. Without
   * this, the case above passes if the opt-out stopped working altogether.
   */
  it('…and the same scoped serve route DOES serve once the token carries the scope', async () => {
    findUniqueMock.mockRejectedValue(new Error('replica unreachable'));
    const handler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
      res.status(200).json({ via: 'handler' });
    });
    // SCOPE is the scope the local `mint()` helper signs, so this token carries it.
    const route = withBlockScope(handler as never, {
      endpoint: 'model_detail',
      requiredScope: SCOPE,
      onApprovalLookupFailure: 'serve',
    });
    const res = makeRes();
    await route(makeReq(await mint()) as never, res as never);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  /**
   * 🔴 THE OPT-OUT IS SCOPED TO `lookup_failed` AND NOTHING ELSE. This is the mutation that
   * would be catastrophic and is easy to write by accident — hoisting the check one branch
   * too far up, or testing `opts.onApprovalLookupFailure` before the verdict. A suspended
   * app on a catalog route must STILL be refused: `not_approved` carries 100% of the gate's
   * protective value and is not opt-outable.
   */
  it('🔴 the opt-out does NOT weaken not_approved — a SUSPENDED app is still 403 on that route', async () => {
    findUniqueMock.mockResolvedValue({ status: 'suspended' });
    const handler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
      res.status(200).json({ via: 'handler' });
    });
    const route = withBlockScope(handler as never, {
      endpoint: 'models',
      onApprovalLookupFailure: 'serve',
    });
    const res = makeRes();
    await route(makeReq(await mint()) as never, res as never);

    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'app block is not approved' });
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
describe('the verdict counter is emitted, once, with the right reason', () => {
  it('a SUSPENDED app → reason not_approved', async () => {
    findUniqueMock.mockResolvedValue({ status: 'suspended' });
    await drive(await mint());
    expect(recordVerdictMock.mock.calls).toEqual([['not_approved']]);
  });

  /**
   * 🔴 BOTH HALVES IN ONE TEST, and that pairing is the point. `not_found` is the one
   * reason that is counted WITHOUT refusing, so the counter and the response are the two
   * things that must hold together: counted-and-refused is the old behaviour, and
   * served-but-uncounted is the gate going silent on its own false-positive channel. Two
   * separate tests would each pass against one of those.
   */
  it('NO ROW → counted under reason not_found AND still served', async () => {
    findUniqueMock.mockResolvedValue(null);
    const { handler, res } = await drive(await mint());
    expect(recordVerdictMock.mock.calls).toEqual([['not_found']]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('a lookup failure → reason lookup_failed', async () => {
    findUniqueMock.mockRejectedValue(new Error('replica unreachable'));
    await drive(await mint());
    expect(recordVerdictMock.mock.calls).toEqual([['lookup_failed']]);
  });

  /**
   * 🔴 COUNTED EVEN WHEN SERVED, and this is the half that keeps the opt-out honest. The
   * whole availability argument for serving is "the verdict is still OBSERVED" — if the
   * counter only fired on the routes that REFUSE, then opting a route out would also opt it
   * out of the alerting signal, and a replica incident would look smaller than it is
   * exactly in proportion to how many routes chose to ride it out.
   */
  it('🔴 a lookup failure on a SERVE route is STILL counted — the signal is not opt-outable', async () => {
    findUniqueMock.mockRejectedValue(new Error('replica unreachable'));
    const handler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
      res.status(200).json({ via: 'handler' });
    });
    const route = withBlockScope(handler as never, {
      endpoint: 'models',
      onApprovalLookupFailure: 'serve',
    });
    const res = makeRes();
    await route(makeReq(await mint()) as never, res as never);

    expect(recordVerdictMock.mock.calls).toEqual([['lookup_failed']]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE CONTROL — an APPROVED app emits nothing', async () => {
    findUniqueMock.mockResolvedValue({ status: 'approved' });
    await drive(await mint());
    expect(recordVerdictMock).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL — a REVOKED instance is not counted as an approval refusal', async () => {
    // Revocation is a different signal with a different meaning and a different owner.
    // Counting it here would inflate the series an operator uses to decide whether the
    // approval gate is misbehaving.
    isRevokedMock.mockResolvedValue(true);
    findUniqueMock.mockResolvedValue({ status: 'suspended' });
    await drive(await mint());
    expect(recordVerdictMock).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 THE `not_found` LOG LINE IS THE WHOLE ATTRIBUTION MECHANISM FOR THE ONE BRANCH THIS
 * GATE DELIBERATELY SERVES, which is why it gets tests of its own rather than being taken
 * on trust.
 *
 * The counter carries NO `app_block_id` on purpose — a label that fires once per such
 * request with nothing rate-limiting it would be retained in the Node heap forever, per
 * pod — so the ids live in this log line instead. If the line cannot name the app, the
 * block and the endpoint, then `not_found` is a number with no way to chase it, and the
 * "it is OBSERVED instead of refused" argument loses its second half.
 *
 * `endpoint` is the field that can go wrong silently: `opts.endpoint` is
 * `AppBlockEndpoint | ((req) => AppBlockEndpoint)`, and template-interpolating the union
 * raw stringifies the FUNCTION on the one call site that passes a resolver
 * (`src/pages/api/v1/blocks/tools.ts`). That is not a cosmetic defect — `tools` is one of
 * the four no-`requiredScope` catalog routes, i.e. the thinnest-gated half of the set.
 */
describe('the not_found log line names the app, the block and the RESOLVED endpoint', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /** Drive one request through a route whose endpoint is FUNCTION-valued, like tools.ts. */
  async function driveWithResolver(method: 'GET' | 'POST') {
    const handler = vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
      res.status(200).json({ via: 'handler' });
    });
    // Byte-for-byte the shape `src/pages/api/v1/blocks/tools.ts` passes today.
    const route = withBlockScope(handler as never, {
      endpoint: (req: NextApiRequest) => (req.method === 'POST' ? 'tools_call' : 'tools'),
    });
    const req = { ...makeReq(await mint()), method } as NextApiRequest;
    const res = makeRes();
    await route(req as never, res as never);
    return { handler, res };
  }

  function lastWarn(): string {
    const call = warnSpy.mock.calls.at(-1);
    return String(call?.[0] ?? '');
  }

  it('a STRING endpoint is logged as itself', async () => {
    findUniqueMock.mockResolvedValue(null);
    await drive(await mint());
    expect(lastWarn()).toContain('endpoint=me');
    expect(lastWarn()).toContain(`appId=${APP_ID}`);
    expect(lastWarn()).toContain(`blockId=${BLOCK_ID}`);
  });

  /**
   * 🔴 THE REGRESSION THIS FILE EXISTS FOR. Before the fix this line read
   * `endpoint=(req) => (req.method === 'POST' ? 'tools_call' : 'tools')` — the function's
   * SOURCE TEXT, on every `not_found` on the tools route.
   *
   * Asserted in BOTH directions, because the positive alone is walkable: a line that
   * contains the resolved value can still also contain the stringified function (a naive
   * "log both" fix), and the arrow text is the half an operator's grep would trip over.
   */
  it('a FUNCTION endpoint is RESOLVED against the request, not stringified (POST)', async () => {
    findUniqueMock.mockResolvedValue(null);
    const { handler, res } = await driveWithResolver('POST');
    expect(lastWarn()).toContain('endpoint=tools_call');
    expect(lastWarn()).not.toContain('=>');
    expect(lastWarn()).not.toContain('req.method');
    // The branch is still SERVED — the log fix must not have moved the policy.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  /**
   * The OTHER arm of the same resolver. A fix that resolved the function but ignored the
   * request (e.g. calling it with no argument, or hardcoding one branch) passes the POST
   * case above and fails here — `tools_call` and `tools` are the two values that one call
   * site can produce, and the whole reason it is a function is that they differ.
   */
  it('the SAME resolver logs the OTHER value on a GET — it is resolved PER REQUEST', async () => {
    findUniqueMock.mockResolvedValue(null);
    await driveWithResolver('GET');
    expect(lastWarn()).toContain('endpoint=tools');
    expect(lastWarn()).not.toContain('endpoint=tools_call');
  });

  it('NEGATIVE CONTROL — an approved app logs nothing at all', async () => {
    findUniqueMock.mockResolvedValue({ status: 'approved' });
    await drive(await mint());
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 THE `lookup_failed` LOG IS THROTTLED, BECAUSE THE FAILURE IT REPORTS IS FLEET-WIDE.
 * An unreachable read replica fails EVERY block REST request on EVERY pod simultaneously,
 * so an unthrottled line here is a log-volume event at full REST rate — the incident's own
 * second-order cost, landing exactly when someone needs to read the logs.
 *
 * Three properties, and the first two are the ones a naive sampler gets wrong:
 *   1. The FIRST failure logs immediately (a 1-in-N sampler drops it (N-1)/N of the time,
 *      and "when did this start" is the question the log is for).
 *   2. The suppressed COUNT is carried on the next line, so the rate stays recoverable
 *      from the log rather than being silently discarded.
 *   3. The COUNTER is untouched by any of this — see the counting suite above.
 */
describe('the lookup_failed log is throttled per pod', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetApprovalLookupFailureLogThrottleForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    findUniqueMock.mockRejectedValue(new Error('replica unreachable'));
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
    __resetApprovalLookupFailureLogThrottleForTests();
  });

  const claims = {
    appId: APP_ID,
    blockId: BLOCK_ID,
  } as Parameters<typeof resolveRestApprovalVerdict>[0];

  it('logs the FIRST failure immediately', async () => {
    expect(await resolveRestApprovalVerdict(claims)).toBe('lookup_failed');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('replica unreachable');
    expect(String(warnSpy.mock.calls[0][0])).toContain('droppedSinceLastLog=0');
  });

  it('🔴 collapses a burst to ONE line while every verdict is still returned', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    for (let i = 0; i < 500; i++) {
      expect(await resolveRestApprovalVerdict(claims)).toBe('lookup_failed');
    }
    // 500 failures, 1 line. Without the throttle this is 500 lines, per pod.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('🔴 the next line after a burst carries the SUPPRESSED COUNT', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    for (let i = 0; i < 500; i++) await resolveRestApprovalVerdict(claims);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Past the window: the next failure logs again, and reports the 499 it swallowed.
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    await resolveRestApprovalVerdict(claims);

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[1][0])).toContain('droppedSinceLastLog=499');
  });

  it('the suppressed counter RESETS after it is reported', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    for (let i = 0; i < 10; i++) await resolveRestApprovalVerdict(claims);

    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    await resolveRestApprovalVerdict(claims);
    expect(String(warnSpy.mock.calls[1][0])).toContain('droppedSinceLastLog=9');

    // A second window with a single failure must report 0, not carry 9 forward.
    vi.setSystemTime(new Date('2026-01-01T00:02:02Z'));
    await resolveRestApprovalVerdict(claims);
    expect(String(warnSpy.mock.calls[2][0])).toContain('droppedSinceLastLog=0');
  });

  it('NEGATIVE CONTROL — a SUCCESSFUL lookup logs nothing and consumes no window', async () => {
    findUniqueMock.mockResolvedValue({ status: 'approved' });
    for (let i = 0; i < 50; i++) await resolveRestApprovalVerdict(claims);
    expect(warnSpy).not.toHaveBeenCalled();

    // …and the throttle is still unarmed, so a real failure right after still logs at once.
    findUniqueMock.mockRejectedValue(new Error('replica unreachable'));
    await resolveRestApprovalVerdict(claims);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
