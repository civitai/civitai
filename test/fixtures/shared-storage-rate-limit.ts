import { TRPCClientError } from '@trpc/client';

/**
 * A shared-storage rate-limit refusal as a host's tRPC client receives it, for the host bridge
 * tests: `data.rateLimit` is what the server's error formatter lifts off the refusal. The prose
 * says 1849s against a `retryAfterSeconds` of 17, so a host that parsed the message would fail.
 */
export const RATE_LIMIT = {
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
