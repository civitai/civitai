import { describe, it, expect, vi, beforeEach } from 'vitest';

// POST /api/auth/exchange — the unauthenticated cross-domain swap-token redeem oracle. Mock all its
// collaborators so we can assert the HARDENING gates (B4): rate limit then single-use, in order.
const h = vi.hoisted(() => ({
  verifySwapToken: vi.fn(),
  getOrProduce: vi.fn(),
  mintUserSession: vi.fn(),
  consumeSwapToken: vi.fn(),
  checkRateLimit: vi.fn(),
}));
vi.mock('$lib/server/auth/verifier', () => ({ verifier: { verifySwapToken: h.verifySwapToken } }));
vi.mock('$lib/server/auth/session-producer', () => ({ getOrProduceSessionUser: h.getOrProduce }));
vi.mock('$lib/server/auth/session', () => ({ mintUserSession: h.mintUserSession }));
vi.mock('$lib/server/auth/swap', () => ({ consumeSwapToken: h.consumeSwapToken }));
vi.mock('$lib/server/auth/rate-limit', () => ({ checkRateLimit: h.checkRateLimit }));

import { POST } from '../../../../routes/api/auth/exchange/+server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (opts: { body?: unknown; ip?: string } = {}): any => ({
  request: new Request('http://h/api/auth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }),
  getClientAddress: () => opts.ip ?? '1.2.3.4',
});

beforeEach(() => {
  vi.clearAllMocks();
  h.checkRateLimit.mockResolvedValue(true); // allowed
  h.verifySwapToken.mockResolvedValue({ userId: 5, jti: 'jti-1' });
  h.consumeSwapToken.mockResolvedValue(true); // first use
  h.getOrProduce.mockResolvedValue({ id: 5, username: 'alice' });
  h.mintUserSession.mockResolvedValue('minted.jwt');
});

describe('POST /api/auth/exchange hardening (B4)', () => {
  it('redeems a valid, single-use token', async () => {
    const res = await POST(ev({ body: { swapToken: 's.jwt' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'minted.jwt', userId: 5 });
  });

  it('429 when rate-limited — and never touches the swap token', async () => {
    h.checkRateLimit.mockResolvedValue(false);
    await expect(POST(ev({ body: { swapToken: 's.jwt' } }))).rejects.toMatchObject({ status: 429 });
    expect(h.verifySwapToken).not.toHaveBeenCalled();
  });

  it('401 on an invalid swap token (single-use never consulted)', async () => {
    h.verifySwapToken.mockResolvedValue(null);
    await expect(POST(ev({ body: { swapToken: 'bad' } }))).rejects.toMatchObject({ status: 401 });
    expect(h.consumeSwapToken).not.toHaveBeenCalled();
  });

  it('409 on a replay (single-use already burned)', async () => {
    h.consumeSwapToken.mockResolvedValue(false);
    await expect(POST(ev({ body: { swapToken: 's.jwt' } }))).rejects.toMatchObject({ status: 409 });
    expect(h.mintUserSession).not.toHaveBeenCalled();
  });

  it('400 when no swap token is supplied', async () => {
    await expect(POST(ev({ body: {} }))).rejects.toMatchObject({ status: 400 });
  });

  it('400 on a blank or non-string swap token (never verifies/consumes)', async () => {
    for (const body of [{ swapToken: '' }, { swapToken: 123 }, { swapToken: null }] as const) {
      await expect(POST(ev({ body }))).rejects.toMatchObject({ status: 400 });
    }
    // unparseable body → coerced to missing → 400 (still after the rate-limit gate).
    await expect(
      POST({
        request: new Request('http://h/api/auth/exchange', { method: 'POST', body: 'not json' }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getClientAddress: () => '1.2.3.4',
      } as any)
    ).rejects.toMatchObject({ status: 400 });
    expect(h.verifySwapToken).not.toHaveBeenCalled();
    expect(h.consumeSwapToken).not.toHaveBeenCalled();
  });

  it('rate-limit gate runs FIRST — a malformed body is still throttled', async () => {
    // Asserts gate ORDER can't be reordered: even an obviously-bad request consumes the IP budget
    // before any token work, so the mint oracle can't be hammered to probe verify/consume behavior.
    h.checkRateLimit.mockResolvedValue(false);
    await expect(POST(ev({ body: {} }))).rejects.toMatchObject({ status: 429 });
    expect(h.verifySwapToken).not.toHaveBeenCalled();
    expect(h.consumeSwapToken).not.toHaveBeenCalled();
    expect(h.mintUserSession).not.toHaveBeenCalled();
  });

  it('404 (and NO mint) when the user no longer exists — single-use already burned', async () => {
    // The jti is consumed before user lookup, so a token for a deleted user is still spent (can't be
    // replayed) yet yields no session. Confirms consume precedes mint, with mint gated on a real user.
    h.getOrProduce.mockResolvedValue(null);
    await expect(POST(ev({ body: { swapToken: 's.jwt' } }))).rejects.toMatchObject({ status: 404 });
    expect(h.consumeSwapToken).toHaveBeenCalledTimes(1);
    expect(h.mintUserSession).not.toHaveBeenCalled();
  });
});
