import { TRPCClientError } from '@trpc/client';

/**
 * A shared-storage rate-limit refusal as a host's tRPC client receives it, for the host bridge
 * tests: `data.rateLimit` is what the server's error formatter lifts off the refusal.
 */
export const RATE_LIMIT = {
  code: 'RATE_LIMITED',
  retryAfterSeconds: 17,
  retryAt: '2031-04-05T06:07:08.000Z',
};

export function rateLimitedClientError(message: string) {
  return TRPCClientError.from({
    error: {
      message,
      code: -32029,
      data: { code: 'TOO_MANY_REQUESTS', httpStatus: 429, rateLimit: RATE_LIMIT },
    },
  });
}

export const RATE_LIMITED_OPS = [
  {
    type: 'SHARED_APPEND',
    mock: 'append',
    payload: { value: { title: 'spam' } },
    message: 'Too many submissions — retry in 17s',
    reply: {},
  },
  {
    type: 'SHARED_UPDATE',
    mock: 'update',
    payload: { key: '01EXISTING', value: { title: 'edit' } },
    message: 'Too many submissions — retry in 17s',
    reply: { ok: false },
  },
  {
    type: 'SHARED_VOTE',
    mock: 'vote',
    payload: { key: '01ABC' },
    message: 'Too many votes — retry in 17s',
    reply: {},
  },
  {
    type: 'SHARED_UNVOTE',
    mock: 'unvote',
    payload: { key: '01ABC' },
    message: 'Too many votes — retry in 17s',
    reply: {},
  },
  {
    type: 'SHARED_WITHDRAW',
    mock: 'withdraw',
    payload: { key: '01ABC' },
    message: 'Too many withdrawals — retry in 17s',
    reply: {},
  },
  {
    type: 'SHARED_REPORT',
    mock: 'report',
    payload: { key: '01ABC', reason: 'spam' },
    message: 'Too many reports — retry in 17s',
    reply: { ok: false },
  },
] as const;
