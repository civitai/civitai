import { EventEmitter } from 'events';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SessionModule from '~/server/auth/get-server-auth-session';

const session = vi.hoisted(() => ({ value: null as unknown }));
const { creditDeposit, previewDepositCredit } = vi.hoisted(() => ({
  creditDeposit: vi.fn(async () => ({ credited: true })),
  previewDepositCredit: vi.fn(async () => ({ decision: 'credit' })),
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionModule>()),
  getServerAuthSession: async () => session.value,
}));
vi.mock('~/server/services/nowpayments-credit.service', () => ({
  creditDeposit,
  previewDepositCredit,
}));

const { default: handler } = await import('~/pages/api/mod/nowpayments/credit-deposit');

const send = async (method: string, { query = {}, body }: { query?: object; body?: unknown }) => {
  const req = Object.assign(new EventEmitter(), {
    method,
    url: '/api/mod/nowpayments/credit-deposit',
    query,
    headers: {},
    body,
  }) as unknown as NextApiRequest;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    getHeader: (name: string) => res.headers[name.toLowerCase()],
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json: () => res,
    end: () => res,
  });
  await handler(req, res as unknown as NextApiResponse);
  return res.statusCode;
};

const moderator = { user: { id: 7, isModerator: true } };

beforeEach(() => vi.clearAllMocks());

describe('credit-deposit', () => {
  it.each([
    ['no session', null],
    ['a member', { user: { id: 5, isModerator: false } }],
  ])('refuses %s before touching the payment', async (_name, value) => {
    session.value = value;
    expect(await send('POST', { body: { paymentId: 5012345678 } })).toBe(401);
    expect(creditDeposit).not.toHaveBeenCalled();
    expect(previewDepositCredit).not.toHaveBeenCalled();
  });

  it('only previews on GET', async () => {
    session.value = moderator;
    const status = await send('GET', {
      query: { paymentId: '5012345678', acknowledge: 'a,b', ticketId: '1' },
    });

    expect(status).toBe(200);
    expect(previewDepositCredit).toHaveBeenCalledWith({
      paymentId: 5012345678,
      acknowledge: ['a', 'b'],
      modUserId: 7,
    });
    expect(creditDeposit).not.toHaveBeenCalled();
  });

  it('credits on POST as the signed-in moderator', async () => {
    session.value = moderator;
    const status = await send('POST', {
      body: { paymentId: 5012345678, acknowledge: ['a'], ticketId: '90002' },
    });

    expect(status).toBe(200);
    expect(creditDeposit).toHaveBeenCalledWith({
      paymentId: 5012345678,
      acknowledge: ['a'],
      ticketId: '90002',
      modUserId: 7,
    });
  });

  it('answers a refused credit with 409', async () => {
    session.value = moderator;
    creditDeposit.mockResolvedValueOnce({ credited: false });

    expect(await send('POST', { body: { paymentId: 5012345678 } })).toBe(409);
  });

  it('rejects a request with no payment id', async () => {
    session.value = moderator;
    expect(await send('POST', { body: {} })).toBe(400);
    expect(creditDeposit).not.toHaveBeenCalled();
  });
});
