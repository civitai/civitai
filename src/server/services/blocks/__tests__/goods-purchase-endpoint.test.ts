import { beforeEach, describe, expect, it, vi } from 'vitest';
// RSA env for the (real) middleware's block-token.service module load.
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

import type * as BlockGoodsService from '~/server/services/blocks/block-goods.service';
import type * as GoodsRateLimit from '~/server/utils/block-goods-rate-limit';

/**
 * `POST /api/v1/blocks/goods/purchase` — the endpoint's own contract: the
 * subject binding, the caps and their refunds, the two-layer idempotency, and
 * the FIN-1 property that no body field can name a buyer, an app or a price.
 *
 * 🔴 These are behaviour specs and invariant guards for NEW code, not
 * regression coverage — there is no earlier behaviour to regress.
 *
 * The rate-limit / cap / idempotency module is mocked so each lever can be
 * driven independently; its own arithmetic is not under test here. The service
 * is mocked so the endpoint's decisions are visible without a database.
 */

const {
  mockPurchase,
  mockResolve,
  mockRateLimit,
  mockReserve,
  mockRefund,
  mockClaim,
  mockFinalize,
  mockRelease,
} = vi.hoisted(() => ({
  mockPurchase: vi.fn(),
  mockResolve: vi.fn(),
  mockRateLimit: vi.fn(async () => ({ allowed: true })),
  mockReserve: vi.fn(async () => ({ total: 1000, key: 'goodscap:42:2026-09-27' })),
  mockRefund: vi.fn(async () => undefined),
  // `vi.fn<T>()` rather than named-but-unused parameters: the ARGUMENT TYPES are
  // what make `mock.calls[i][n]` indexable, and naming them only to ignore them
  // trips the unused-vars rule.
  mockClaim: vi.fn<
    (
      userId: number,
      appBlockId: string,
      key: string,
      fingerprint: string
    ) => Promise<{ state: string; key?: string; status?: number; body?: unknown }>
  >(async () => ({ state: 'acquired', key: 'idem:42' })),
  mockFinalize: vi.fn<
    (key: string, status: number, body: unknown, fingerprint: string) => Promise<void>
  >(async () => undefined),
  mockRelease: vi.fn(async () => undefined),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));

vi.mock('~/server/services/blocks/block-goods.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockGoodsService>()),
  purchaseBlockGood: mockPurchase,
  resolveBlockGoodForPurchase: mockResolve,
}));

vi.mock('~/server/utils/block-goods-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof GoodsRateLimit>()),
  checkBlockGoodRateLimit: mockRateLimit,
  reserveBlockGoodSpend: mockReserve,
  refundBlockGoodSpend: mockRefund,
  claimGoodIdempotency: mockClaim,
  finalizeGoodIdempotency: mockFinalize,
  releaseGoodIdempotency: mockRelease,
}));

import { baseHandler } from '~/pages/api/v1/blocks/goods/purchase';
import { readBlockActionDetail } from '~/server/middleware/block-scope.middleware';
import { BLOCK_GOOD_CAP_PER_DAY } from '~/server/utils/block-goods-rate-limit';

const BUYER = 42;
const OWNER = 77;
const APP_BLOCK_ID = 'apb_TESTBLOCK';
const GOOD_ID = 'extra-slots';
const PRICE = 1300;

const RESOLVED = {
  appId: 'appblk-test',
  appOwnerUserId: OWNER,
  manifestVersion: '1.4.0',
  good: {
    id: GOOD_ID,
    title: 'Extra slots',
    priceBuzz: PRICE,
    kind: 'good' as const,
    payload: { slots: 5 },
  },
};

const OK_RESULT = {
  ok: true as const,
  status: 200 as const,
  purchaseId: 'bgp_1',
  goodId: GOOD_ID,
  priceBuzz: PRICE,
  entitlement: {
    goodId: GOOD_ID,
    kind: 'good',
    payload: { slots: 5 },
    grantedAt: '2026-09-27T00:00:00.000Z',
  },
};

type TestRes = NextApiResponse & {
  statusCode: number;
  body?: unknown;
  headers: Record<string, string>;
};

function makeRes(): TestRes {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = String(value);
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as TestRes;
}

function makeReq(
  body: Record<string, unknown>,
  claims: Record<string, unknown> | null = {
    sub: `user:${BUYER}`,
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: 'bki_1',
  },
  method = 'POST'
): NextApiRequest {
  return {
    method,
    headers: {},
    body,
    ...(claims ? { blockClaims: claims } : {}),
  } as unknown as NextApiRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue({ allowed: true } as never);
  mockReserve.mockResolvedValue({ total: PRICE, key: 'goodscap:42:2026-09-27' } as never);
  mockClaim.mockResolvedValue({ state: 'acquired', key: 'idem:42' } as never);
  mockResolve.mockResolvedValue(RESOLVED as never);
  mockPurchase.mockResolvedValue(OK_RESULT as never);
});

describe('auth + method', () => {
  it('405s a non-POST', async () => {
    const res = makeRes();
    await baseHandler(makeReq({}, undefined, 'GET'), res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('POST');
  });

  it('401s with no block claims at all', async () => {
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID }, null), res);
    expect(res.statusCode).toBe(401);
    expect(mockPurchase).not.toHaveBeenCalled();
  });

  it('403s an ANONYMOUS block token — it may not buy', async () => {
    const res = makeRes();
    await baseHandler(
      makeReq({ goodId: GOOD_ID }, { sub: 'anon', appBlockId: APP_BLOCK_ID, blockInstanceId: 'x' }),
      res
    );
    expect(res.statusCode).toBe(403);
    expect(mockPurchase).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it('403s a MALFORMED subject claim', async () => {
    const res = makeRes();
    await baseHandler(
      makeReq(
        { goodId: GOOD_ID },
        { sub: 'user:abc', appBlockId: APP_BLOCK_ID, blockInstanceId: 'x' }
      ),
      res
    );
    expect(res.statusCode).toBe(403);
    expect(mockPurchase).not.toHaveBeenCalled();
  });
});

describe('FIN-1 — no client value reaches a money decision', () => {
  it('spends BLUE before YELLOW — granted Buzz ahead of purchased Buzz', async () => {
    // 🔴 The colour ORDER decides which of the viewer's two balances is spent and
    // what the owner is paid back in. Unasserted, `['yellow','blue']` inverts it
    // with every other test green.
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID }), res);
    expect(mockPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ payWith: ['blue', 'yellow'] })
    );
  });

  it('rate-limits on the token\u2019s own instance id AND the token subject, not a shared constant', async () => {
    // A constant key would make the 6-per-60s bucket GLOBAL across every viewer
    // and every app, so the first six purchases anywhere in the minute would 429
    // everyone else.
    //
    // The BUYER is asserted here too, and it is the half that is easy to lose:
    // the instance id alone is NOT per-viewer for a page app, whose synthetic
    // `page_<appBlockId>` is shared by every concurrent viewer \u2014 so an
    // instance-only key is the "shared constant" this test's title warns about,
    // wearing a different name. Both arguments, so dropping either is red.
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID }), res);
    expect(mockRateLimit).toHaveBeenCalledWith('bki_1', BUYER);
  });

  it('binds the BUYER to the token subject, ignoring a body userId', async () => {
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, userId: 999, buyerUserId: 999 }), res);
    expect(res.statusCode).toBe(200);
    expect(mockPurchase).toHaveBeenCalledWith(expect.objectContaining({ buyerUserId: BUYER }));
    expect(mockPurchase).not.toHaveBeenCalledWith(expect.objectContaining({ buyerUserId: 999 }));
  });

  it('resolves the APP from the token, ignoring a body appId / appBlockId', async () => {
    const res = makeRes();
    await baseHandler(
      makeReq({ goodId: GOOD_ID, appId: 'attacker-app', appBlockId: 'apb_ATTACKER' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(mockResolve).toHaveBeenCalledWith({ appBlockId: APP_BLOCK_ID, goodId: GOOD_ID });
    expect(mockPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ appBlockId: APP_BLOCK_ID, resolved: RESOLVED })
    );
  });

  it('reserves the SERVER price, not a body priceBuzz', async () => {
    // 🔴 The cap is only a ceiling if it reserves the real number. The fixture
    // value (1) is distinct from the real price (1300) and from every constant
    // the assertion names, and it is not a declared body field — so a handler
    // reading `req.body.priceBuzz` reserves 1 and this goes red.
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, priceBuzz: 1 }), res);
    expect(mockReserve).toHaveBeenCalledWith(BUYER, PRICE);
  });

  it('reserves the SERVER price even when a DIFFERENT expectedPriceBuzz is declared', async () => {
    // 🔴 The case the matching-expectation test above structurally CANNOT see:
    // when the client's figure equals the server's, a handler that reserved
    // `expectedPriceBuzz` is indistinguishable from a correct one. Here they
    // differ (999 vs 1300), the service refuses with `price_changed`, and the
    // endpoint refunds — so a mutant reserving the client's figure reserves 999
    // and refunds 1300, leaving the viewer's daily counter permanently short by
    // the difference. Measured: this pairing is what killed that mutant; the
    // matching-value test alone left it SURVIVED.
    mockPurchase.mockResolvedValueOnce({
      ok: false,
      status: 409,
      reason: 'price_changed',
      error: 'The price changed to 1300 Buzz. Check the new price and try again.',
      charge: 'none',
      retryable: false,
    } as never);
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, expectedPriceBuzz: 999 }), res);
    expect(res.statusCode).toBe(409);
    expect(mockReserve).toHaveBeenCalledWith(BUYER, PRICE);
    // Reserve and refund must name the SAME number, or the counter drifts.
    expect(mockRefund).toHaveBeenCalledWith('goodscap:42:2026-09-27', PRICE);
  });

  it('404s — without charging — when the instance resolves to no sellable good', async () => {
    mockResolve.mockResolvedValueOnce(null as never);
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID }), res);
    expect(res.statusCode).toBe(404);
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockPurchase).not.toHaveBeenCalled();
  });
});

describe('body validation', () => {
  it('400s a malformed goodId rather than passing it through', async () => {
    const res = makeRes();
    await baseHandler(makeReq({ goodId: 'Not A Good Id' }), res);
    expect(res.statusCode).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('400s a missing goodId', async () => {
    const res = makeRes();
    await baseHandler(makeReq({}), res);
    expect(res.statusCode).toBe(400);
  });

  it('400s a malformed idempotency key', async () => {
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, idempotencyKey: 'has spaces & colons:' }), res);
    expect(res.statusCode).toBe(400);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('400s a non-integer or out-of-range expectedPriceBuzz', async () => {
    for (const expectedPriceBuzz of [12.5, -1, 0, 10_000_000]) {
      const res = makeRes();
      await baseHandler(makeReq({ goodId: GOOD_ID, expectedPriceBuzz }), res);
      expect(res.statusCode, String(expectedPriceBuzz)).toBe(400);
    }
  });
});

describe('caps and their refunds', () => {
  it('429s — transiently, with Retry-After — when the per-instance limiter refuses', async () => {
    mockRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 17 } as never);
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID }), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('17');
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockPurchase).not.toHaveBeenCalled();
  });

  it('400s over the DAILY cap and REFUNDS the reservation it just made', async () => {
    mockReserve.mockResolvedValueOnce({
      total: BLOCK_GOOD_CAP_PER_DAY + 1,
      key: 'goodscap:42:2026-09-27',
    } as never);
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID }), res);
    expect(res.statusCode).toBe(400);
    // 🔴 Assert the RESERVATION, not just the status: a refund that never
    // happens leaves the viewer's day permanently consumed by a purchase that
    // did not occur, and the response looks identical.
    expect(mockRefund).toHaveBeenCalledWith('goodscap:42:2026-09-27', PRICE);
    expect(mockPurchase).not.toHaveBeenCalled();
  });

  it('503s — transiently — when the limiter itself is unavailable (fail CLOSED)', async () => {
    mockReserve.mockRejectedValueOnce(new Error('redis down'));
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID }), res);
    expect(res.statusCode).toBe(503);
    expect(mockPurchase).not.toHaveBeenCalled();
  });

  it('REFUNDS the reservation on a 4xx refusal from the service', async () => {
    mockPurchase.mockResolvedValueOnce({
      ok: false,
      status: 409,
      reason: 'already_owned',
      error: 'You already own this item',
      charge: 'none',
      retryable: false,
    } as never);
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID }), res);
    expect(res.statusCode).toBe(409);
    expect(mockRefund).toHaveBeenCalledWith('goodscap:42:2026-09-27', PRICE);
  });

  it('REFUNDS the reservation when the LEDGER reports a conflict (duplicate)', async () => {
    // The brief's named case: the deterministic externalTransactionId already
    // existed, so no Buzz moved on this call. Keeping the reservation would
    // charge the viewer's daily allowance twice for one transfer.
    mockPurchase.mockResolvedValueOnce({
      ok: false,
      status: 409,
      reason: 'duplicate',
      error: 'This purchase has already been completed',
      charge: 'none',
      retryable: false,
    } as never);
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID }), res);
    expect(mockRefund).toHaveBeenCalledWith('goodscap:42:2026-09-27', PRICE);
  });

  it('🔴 does NOT refund the reservation on a 503 charge_unknown, and does NOT cache it', async () => {
    // The unknown-outcome path. Keeping the reservation is the safe direction
    // (money may have moved), and caching the verdict under the idempotency key
    // would replay a non-answer instead of letting a retry discover the surviving
    // `pending` claim.
    mockPurchase.mockResolvedValueOnce({
      ok: false,
      status: 503,
      reason: 'charge_unknown',
      error: 'Could not confirm this purchase. Please check your balance before retrying.',
      charge: 'unknown',
      retryable: true,
    } as never);
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, idempotencyKey: 'abc-123' }), res);
    expect(res.statusCode).toBe(503);
    expect(mockRefund).not.toHaveBeenCalled();
    expect(mockFinalize).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledWith('idem:42');
  });

  it('🔴 REFUNDS on a 500 whose charge outcome is KNOWN, and does not cache it', async () => {
    // 🔴 THIS TEST REPLACES ONE THAT ENCODED THE BUG. It used to read "does NOT
    // refund on a 5xx — a post-money failure must leave the cap stricter",
    // asserting exactly the behaviour the audit found wrong, from the same
    // false step the endpoint took: "every UNKNOWN outcome is a 5xx" is true,
    // its converse is not. `charge_failed` is a 500 both when the claim INSERT
    // failed before any charge and when the settle failed AFTER the charge was
    // reversed — the Buzz never left or came straight back in both, so keeping
    // the reservation charges the viewer's daily allowance for nothing, and
    // caching the 500 replays it for the key's full TTL instead of letting the
    // retry through.
    mockPurchase.mockResolvedValueOnce({
      ok: false,
      status: 500,
      reason: 'charge_failed',
      error: 'Could not complete this purchase',
      charge: 'reversed',
      retryable: true,
    } as never);
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, idempotencyKey: 'abc-123' }), res);
    expect(res.statusCode).toBe(500);
    expect(mockRefund).toHaveBeenCalledWith('goodscap:42:2026-09-27', PRICE);
    // Not cached, and the claim is released so the retry is not met with
    // "already in progress".
    expect(mockFinalize).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledWith('idem:42');
  });

  it('KEEPS the reservation when the service reports no charge outcome at all', async () => {
    // 🔴 NEGATIVE CONTROL ON THE ALLOWLIST. The refund test is `charge === 'none'
    // || charge === 'reversed'`, not `charge !== 'unknown'`, so a value the
    // endpoint does not recognise — a future reason that forgot to set it, a
    // mis-built fixture — keeps the reservation rather than handing it back on
    // a charge that may have landed. Without this case an inverted test passes
    // every other test in this file.
    mockPurchase.mockResolvedValueOnce({
      ok: false,
      status: 500,
      reason: 'charge_failed',
      error: 'Could not complete this purchase',
    } as never);
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID }), res);
    expect(res.statusCode).toBe(500);
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it('does NOT refund the reservation when the attempt THROWS', async () => {
    mockPurchase.mockRejectedValueOnce(new Error('boom'));
    const res = makeRes();
    await expect(baseHandler(makeReq({ goodId: GOOD_ID }), res)).rejects.toThrow('boom');
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it('does not refund the reservation on SUCCESS', async () => {
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID }), res);
    expect(res.statusCode).toBe(200);
    expect(mockRefund).not.toHaveBeenCalled();
  });
});

describe('idempotency', () => {
  const KEY = 'abc-123';

  it('runs once and finalizes a TERMINAL outcome under the key', async () => {
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, idempotencyKey: KEY }), res);
    expect(res.statusCode).toBe(200);
    expect(mockFinalize).toHaveBeenCalledTimes(1);
    // 🔴 ALL FOUR arguments. Checking only the status left a mutant passing `''`
    // for the fingerprint alive: the stored record then never matches on the next
    // call, so the legitimate lost-response retry gets 422 "already used for a
    // different purchase" — the exact failure the mismatch handling exists to
    // prevent, inverted. A mutant passing `undefined` for the body replays an
    // empty 200 to a client that then believes it bought nothing.
    expect(mockFinalize).toHaveBeenCalledWith('idem:42', 200, res.body, mockClaim.mock.calls[0][3]);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('409s while the FIRST attempt with the same key + payload is in flight', async () => {
    mockClaim.mockResolvedValueOnce({ state: 'in_progress' } as never);
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, idempotencyKey: KEY }), res);
    expect(res.statusCode).toBe(409);
    expect(res.headers['Retry-After']).toBe('2');
    expect(mockPurchase).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it('REPLAYS a terminal result VERBATIM with no second charge', async () => {
    const cached = { ok: true, purchase: { id: 'bgp_1', goodId: GOOD_ID, priceBuzz: PRICE } };
    mockClaim.mockResolvedValueOnce({ state: 'replay', status: 200, body: cached } as never);
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, idempotencyKey: KEY }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(cached);
    expect(mockPurchase).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it('422s the same key reused for a DIFFERENT payload', async () => {
    mockClaim.mockResolvedValueOnce({ state: 'mismatch' } as never);
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, idempotencyKey: KEY }), res);
    expect(res.statusCode).toBe(422);
    expect(mockPurchase).not.toHaveBeenCalled();
  });

  it('fingerprints on (app, good, SERVER price) — a different good under one key is a mismatch', async () => {
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, idempotencyKey: KEY }), res);
    const firstFingerprint = mockClaim.mock.calls[0][3];

    mockResolve.mockResolvedValueOnce({
      ...RESOLVED,
      good: { ...RESOLVED.good, id: 'other-good', priceBuzz: 2600 },
    } as never);
    const res2 = makeRes();
    await baseHandler(makeReq({ goodId: 'other-good', idempotencyKey: KEY }), res2);
    expect(mockClaim.mock.calls[1][3]).not.toBe(firstFingerprint);
  });

  it('RELEASES the claim on a transient 429 so a real retry can execute', async () => {
    mockRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 5 } as never);
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, idempotencyKey: KEY }), res);
    expect(res.statusCode).toBe(429);
    expect(mockRelease).toHaveBeenCalledWith('idem:42');
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it('RELEASES the claim on a transient 503', async () => {
    mockReserve.mockRejectedValueOnce(new Error('redis down'));
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, idempotencyKey: KEY }), res);
    expect(res.statusCode).toBe(503);
    expect(mockRelease).toHaveBeenCalledWith('idem:42');
  });

  it('RELEASES the claim when the attempt THROWS, and rethrows', async () => {
    // 🔴 Without this the sentinel survives its full TTL and 409s every retry
    // with "already in progress" when nothing is — making the purchase
    // unlandable after a transient blip, which is exactly when retrying with
    // the same key is the point.
    mockPurchase.mockRejectedValueOnce(new Error('kaboom'));
    const res = makeRes();
    await expect(
      baseHandler(makeReq({ goodId: GOOD_ID, idempotencyKey: KEY }), res)
    ).rejects.toThrow('kaboom');
    expect(mockRelease).toHaveBeenCalledWith('idem:42');
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  it('503s and does NOT dedupe blind when the claim store is unavailable (fail CLOSED)', async () => {
    mockClaim.mockRejectedValueOnce(new Error('redis down'));
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, idempotencyKey: KEY }), res);
    expect(res.statusCode).toBe(503);
    expect(mockPurchase).not.toHaveBeenCalled();
    expect(mockReserve).not.toHaveBeenCalled();
  });

  it('keys the claim per (user, APP, key) so two apps cannot share a slot', async () => {
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID, idempotencyKey: KEY }), res);
    expect(mockClaim).toHaveBeenCalledWith(BUYER, APP_BLOCK_ID, KEY, expect.any(String));
  });

  it('runs with NO dedupe when no key is supplied', async () => {
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID }), res);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockFinalize).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});

describe('audit detail', () => {
  it('stashes a goods.purchase detail naming the good and the amount', async () => {
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID }), res);
    expect(readBlockActionDetail(res)).toEqual({
      action: 'goods.purchase',
      goodId: GOOD_ID,
      amount: PRICE,
      outcome: 'ok',
    });
  });

  it('stashes NOTHING when the purchase is refused, and REFUNDS the reservation', async () => {
    // 🔴 The refund assertion lives here because every OTHER test of that branch
    // drives a 409. With only 409 fixtures, `if (result.status === 409)` survives
    // — and 400 `insufficient_funds` is the most frequent refusal on the surface,
    // so the viewer's daily counter would drift fastest exactly where nothing
    // moved.
    mockPurchase.mockResolvedValueOnce({
      ok: false,
      status: 400,
      reason: 'insufficient_funds',
      error: 'You do not have enough Buzz to buy this item',
      charge: 'none',
      retryable: false,
    } as never);
    const res = makeRes();
    await baseHandler(makeReq({ goodId: GOOD_ID }), res);
    expect(readBlockActionDetail(res)).toBeUndefined();
    expect(mockRefund).toHaveBeenCalledWith('goodscap:42:2026-09-27', PRICE);
  });
});
