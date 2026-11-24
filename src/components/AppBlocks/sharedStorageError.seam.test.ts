import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTRPC, TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createTRPCClient, httpLink, TRPCClientError } from '@trpc/client';
import { errorFormatter } from '~/server/trpc/error-formatter';
import { throwAppRateLimited } from '~/server/utils/app-rate-limit';
import { buildTransformer, clientTransformer } from '~/shared/utils/trpc-union-transformer';
import { sharedStorageErrorReply } from '~/components/AppBlocks/sharedStorageError';
import { rateLimitReplyFields } from '~/components/AppBlocks/bridgeRateLimit';
import { getRateLimit } from '~/utils/rate-limit';

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
    throwAppRateLimited('apps.shared-storage', 17, MESSAGE)
  ),
  createPost: t.procedure.mutation((): { postId: number } =>
    throwAppRateLimited('apps.post', 17, MESSAGE)
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
      rateLimit: {
        retryAfterSeconds: 17,
        retryAt: RETRY_AT,
        id: 'apps.shared-storage',
        kind: 'abuse',
      },
    });
  });

  it('a refusal by a non-storage limiter carries its rateLimit into any bridge error reply', async () => {
    // CREATE_POST_FROM_APP's posts limiter: the hosts spread rateLimitReplyFields(err) into
    // every error reply built from a caught server error, not only shared storage's.
    const err = await rejection(() => client.createPost.mutate());

    expect({ requestId: 'rq_seam', error: 'x', ...rateLimitReplyFields(err) }).toEqual({
      requestId: 'rq_seam',
      error: 'x',
      rateLimit: {
        retryAfterSeconds: 17,
        retryAt: RETRY_AT,
        id: 'apps.post',
        kind: 'abuse',
      },
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
    expect(rateLimitReplyFields(new Error('boom'))).toEqual({});
  });
});

describe('getRateLimit validates the network-supplied data.rateLimit', () => {
  const VALID = { retryAfterSeconds: 17, retryAt: RETRY_AT };
  const withRateLimit = (rateLimit: unknown) => ({ data: { rateLimit } });

  it('accepts the 1-second minimum', () => {
    const minimum = { retryAfterSeconds: 1, retryAt: RETRY_AT };
    expect(getRateLimit(withRateLimit(minimum))).toEqual(minimum);
  });

  it('copies only the known fields', () => {
    expect(getRateLimit(withRateLimit({ ...VALID, internalKey: 'bucket:42' }))).toEqual(VALID);
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
    expect(getRateLimit(withRateLimit(rateLimit))).toBeUndefined();
  });
});
