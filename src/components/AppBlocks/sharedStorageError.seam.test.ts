import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTRPC, TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import { errorFormatter } from '~/server/trpc/error-formatter';
import { throwSharedRateLimited } from '~/server/utils/rate-limit-error';
import { buildTransformer, clientTransformer } from '~/shared/utils/trpc-union-transformer';
import {
  sharedStorageErrorReply,
  storageErrorRateLimit,
} from '~/components/AppBlocks/sharedStorageError';

/**
 * The seam between the server refusal and the host's bridge reply: the real refusal helper,
 * the real error formatter and transformers, a real fetch handler and a real tRPC client. A
 * break anywhere along it (the formatter not lifting `cause.rateLimit`, the transformer
 * dropping it, the host reading the wrong field) loses `rateLimit` from the reply.
 */

// The refusal helper derives retryAt from the clock: NOW + 17s.
const NOW = Date.parse('2031-04-05T06:06:51.000Z');
const RETRY_AT = '2031-04-05T06:07:08.000Z';
const MESSAGE = 'Too many submissions — retry in 17s';

const t = initTRPC.create({ transformer: buildTransformer(), errorFormatter });
const appRouter = t.router({
  append: t.procedure.mutation((): { key: string } =>
    throwSharedRateLimited({ retryAfterSeconds: 17 }, MESSAGE)
  ),
  forbidden: t.procedure.mutation((): { key: string } => {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'shared storage is not enabled' });
  }),
});

const client = createTRPCClient<typeof appRouter>({
  links: [
    httpLink({
      url: 'http://localhost/api/trpc',
      transformer: clientTransformer,
      fetch: (input, init) =>
        fetchRequestHandler({
          endpoint: '/api/trpc',
          req: new Request(input as RequestInfo, init as RequestInit),
          router: appRouter,
        }),
    }),
  ],
});

async function rejection(call: () => Promise<unknown>) {
  const err = await call().then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(TRPCClientError);
  return err;
}

describe('rate-limit refusal → host SHARED_APPEND_RESULT reply', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the reply carries the prose error AND the structured rateLimit', async () => {
    const err = await rejection(() => client.append.mutate());

    expect({ requestId: 'rq_seam', ...sharedStorageErrorReply(err) }).toEqual({
      requestId: 'rq_seam',
      error: MESSAGE,
      rateLimit: { retryAfterSeconds: 17, retryAt: RETRY_AT },
    });
  });

  it('INVARIANT GUARD: a non-rate-limit refusal replies with the error alone', async () => {
    const err = await rejection(() => client.forbidden.mutate());

    expect({ requestId: 'rq_seam', ...sharedStorageErrorReply(err) }).toEqual({
      requestId: 'rq_seam',
      error: 'shared storage is not enabled',
    });
  });

  it('a plain Error replies with its message alone', () => {
    expect(sharedStorageErrorReply(new Error('boom'))).toEqual({ error: 'boom' });
  });
});

describe('storageErrorRateLimit validates the network-supplied data.rateLimit', () => {
  const VALID = { retryAfterSeconds: 17, retryAt: RETRY_AT };
  const withRateLimit = (rateLimit: unknown) => ({ data: { rateLimit } });

  it('accepts the 1-second minimum', () => {
    const minimum = { retryAfterSeconds: 1, retryAt: RETRY_AT };
    expect(storageErrorRateLimit(withRateLimit(minimum))).toEqual(minimum);
  });

  it('copies only the known fields', () => {
    expect(storageErrorRateLimit(withRateLimit({ ...VALID, internalKey: 'bucket:42' }))).toEqual(
      VALID
    );
  });

  it.each([
    ['a string retryAfterSeconds', { ...VALID, retryAfterSeconds: '17' }],
    ['a zero retryAfterSeconds', { ...VALID, retryAfterSeconds: 0 }],
    ['a fractional retryAfterSeconds', { ...VALID, retryAfterSeconds: 1.5 }],
    ['a missing retryAt', { retryAfterSeconds: 17 }],
    ['an unparseable retryAt', { ...VALID, retryAt: 'soon' }],
    ['a string', 'retry later'],
    ['null', null],
  ])('drops a malformed rateLimit (%s)', (_label, rateLimit) => {
    expect(storageErrorRateLimit(withRateLimit(rateLimit))).toBeUndefined();
  });
});
