import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { initTRPC, TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { getClientSafeError } from '~/server/trpc/client-safe-error';
import { router } from '~/server/trpc';
import { errorFormatter } from '~/server/trpc/error-formatter';

const shape = {
  message: 'Your prompt was flagged: daughter',
  code: -32600,
  data: { code: 'BAD_REQUEST', httpStatus: 400 },
} as Parameters<typeof errorFormatter>[0]['shape'];

function format(cause: unknown) {
  const error = new TRPCError({ code: 'BAD_REQUEST', message: shape.message, cause });
  return errorFormatter({ shape, error }) as { data: Record<string, unknown> };
}

it('is the formatter the app router is built with', () => {
  expect(router({})._def._config.errorFormatter).toBe(errorFormatter);
});

describe('trpc errorFormatter — softBlock lifting', () => {
  it('lifts cause.softBlock onto data', () => {
    const result = format({ softBlock: true });
    expect(result.data.softBlock).toBe(true);
    // The spread must not drop what tRPC already put on `data`.
    expect(result.data.code).toBe('BAD_REQUEST');
  });

  it.each([
    ['no cause', undefined],
    ['an Error cause', new Error('boom')],
    ['a string cause', 'boom'],
    ['a null cause', null],
    ['softBlock false', { softBlock: false }],
    ['a truthy non-boolean softBlock', { softBlock: 'yes' }],
  ])('leaves the shape untouched for %s', (_label, cause) => {
    expect(format(cause).data.softBlock).toBeUndefined();
  });
});

const READ_ONLY_TEXT =
  'Invalid `prisma.apiKey.create()` invocation: QueryError(PostgresError { code: "25006", ' +
  'message: "cannot execute INSERT in a read-only transaction" })';

async function callThroughTrpc(thrown: unknown) {
  const t = initTRPC.create({ errorFormatter });
  const router = t.router({
    create: t.procedure.mutation(() => {
      throw thrown;
    }),
  });
  const loggedRefs: (string | undefined)[] = [];
  const res = await fetchRequestHandler({
    endpoint: '/api/trpc',
    req: new Request('http://localhost/api/trpc/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    router,
    onError: ({ error }) => loggedRefs.push(getClientSafeError(error)?.errorRef),
  });
  const body = (await res.json()) as {
    error: {
      message: string;
      data: {
        errorRef?: string;
        httpStatus: number;
        softBlock?: boolean;
        rateLimit?: unknown;
      } & Record<string, unknown>;
    };
  };
  return { status: res.status, error: body.error, loggedRefs };
}

describe('trpc errorFormatter — server faults, through a real tRPC handler', () => {
  it('masks a 500, and onError sees the same ref the response carries', async () => {
    const { status, error, loggedRefs } = await callThroughTrpc(
      new Prisma.PrismaClientUnknownRequestError(READ_ONLY_TEXT, { clientVersion: '6.13.0' })
    );

    expect(status).toBe(500);
    expect(error.message).not.toContain('prisma');
    expect(error.message).not.toContain('25006');
    expect(error.data.errorRef).toMatch(/^[0-9a-f]{12}$/);
    expect(error.message).toContain(`(ref: ${error.data.errorRef})`);
    expect(loggedRefs).toEqual([error.data.errorRef]);
  });

  it('keeps the status and the rest of `data` on a masked error', async () => {
    const { status, error } = await callThroughTrpc(new Error('Query read timeout'));

    expect(status).toBe(500);
    expect(error.data).toMatchObject({
      httpStatus: 500,
      code: 'INTERNAL_SERVER_ERROR',
      path: 'create',
    });
    expect(error.message).toBe(`An unexpected error occurred (ref: ${error.data.errorRef})`);
  });

  it('passes a message we wrote through unchanged, with no ref', async () => {
    const { status, error, loggedRefs } = await callThroughTrpc(
      new TRPCError({ code: 'BAD_REQUEST', message: 'That slug is already taken' })
    );

    expect(status).toBe(400);
    expect(error.message).toBe('That slug is already taken');
    expect(error.data.errorRef).toBeUndefined();
    expect(loggedRefs).toEqual([undefined]);
  });
});

const RATE_LIMIT = {
  retryAfterSeconds: 17,
  retryAt: '2031-04-05T06:07:08.000Z',
};
const REFUSAL = 'Too many votes — retry in 17s';

function rateLimited(
  cause: unknown,
  code: 'TOO_MANY_REQUESTS' | 'FORBIDDEN' = 'TOO_MANY_REQUESTS'
) {
  return new TRPCError({ code, message: REFUSAL, cause });
}

describe('trpc errorFormatter — rate-limit retry metadata, through a real tRPC handler', () => {
  it('lifts cause.rateLimit onto data.rateLimit and keeps the message', async () => {
    const { status, error } = await callThroughTrpc(rateLimited({ rateLimit: RATE_LIMIT }));

    expect(status).toBe(429);
    expect(error.message).toBe(REFUSAL);
    expect(error.data.rateLimit).toEqual(RATE_LIMIT);
    expect(error.data).toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      httpStatus: 429,
      path: 'create',
    });
  });

  it('merges with the softBlock branch instead of returning before it', async () => {
    const { error } = await callThroughTrpc(
      rateLimited({ softBlock: true, rateLimit: RATE_LIMIT })
    );
    expect(error.data.softBlock).toBe(true);
    expect(error.data.rateLimit).toEqual(RATE_LIMIT);
  });

  it.each([
    ['no rateLimit', { softBlock: false }],
    ['a non-object rateLimit', { rateLimit: 'retry later' }],
  ])('INVARIANT GUARD: a 429 whose cause carries %s gets no data.rateLimit', async (_l, cause) => {
    const { status, error } = await callThroughTrpc(rateLimited(cause));
    expect(status).toBe(429);
    expect(error.message).toBe(REFUSAL);
    expect('rateLimit' in error.data).toBe(false);
  });

  it('INVARIANT GUARD: ignores a rateLimit cause on a non-429 error', async () => {
    const { status, error } = await callThroughTrpc(
      rateLimited({ rateLimit: RATE_LIMIT }, 'FORBIDDEN')
    );
    expect(status).toBe(403);
    expect('rateLimit' in error.data).toBe(false);
  });

  it('INVARIANT GUARD: a non-rate-limit error has no rateLimit key and an unchanged data shape', async () => {
    const { error } = await callThroughTrpc(
      new TRPCError({ code: 'BAD_REQUEST', message: 'That slug is already taken' })
    );
    expect(Object.keys(error.data).sort()).toEqual(['code', 'httpStatus', 'path', 'stack'].sort());
  });

  it('INVARIANT GUARD: a masked 500 still carries errorRef and no rateLimit', async () => {
    const { error } = await callThroughTrpc(new Error('Query read timeout'));
    expect(error.data.errorRef).toMatch(/^[0-9a-f]{12}$/);
    expect('rateLimit' in error.data).toBe(false);
  });
});
