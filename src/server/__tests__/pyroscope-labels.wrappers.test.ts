import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The call sites read `pyroscopeArmed` at module load, so the flag is set before any import.
vi.hoisted(() => {
  process.env.PYROSCOPE_ENABLED = 'true';
});

vi.mock('@civitai/next-axiom', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withAxiom: (handler: unknown) => handler,
}));

const { __resetProfileRouteLabelsForTests, startWallProfilingWithAsyncContext } = await import(
  '~/server/pyroscope-labels'
);
const { TokenSecuredEndpoint } = await import('~/server/utils/endpoint-helpers');
const { createCallerFactory, publicProcedure, router } = await import('~/server/trpc');
const { TokenScope } = await import('~/shared/constants/token-scope.constants');

// The REAL request wrappers (withApiMetrics via TokenSecuredEndpoint, the tRPC procedure chain via
// publicProcedure) on an armed fake profiler: asserts the label value a handler runs under, after
// an await, so a constant route string or a dropped apiProfileRoute goes red.

const store = new AsyncLocalStorage<{ labels?: Record<string, string> }>();
const fakeTime = {
  started: false,
  start() {
    fakeTime.started = true;
  },
  isStarted: () => fakeTime.started,
  runWithContext<R>(context: object, fn: () => R): R {
    return store.run(context, fn);
  },
};
const routeNow = () => store.getStore()?.labels?.route;

beforeAll(() => {
  expect(startWallProfilingWithAsyncContext(() => fakeTime.start(), fakeTime)).toBe(true);
});

afterAll(() => {
  __resetProfileRouteLabelsForTests();
  delete process.env.PYROSCOPE_ENABLED;
});

describe('pages-API route label through withApiMetrics', () => {
  const SECRET = 'a'.repeat(40);
  let seen: string | undefined;
  const endpoint = TokenSecuredEndpoint(SECRET, async () => {
    await sleep(1);
    seen = routeNow();
  }) as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

  async function call(method: string, url: string) {
    seen = undefined;
    const res = { status: () => res, json: () => res } as unknown as NextApiResponse;
    await endpoint(
      {
        method,
        url,
        query: {},
        headers: { authorization: `Bearer ${SECRET}` },
      } as unknown as NextApiRequest,
      res
    );
    return seen;
  }

  it('labels the handler with the normalized method and route', async () => {
    expect(await call('GET', '/api/v1/images?limit=5')).toBe('api:GET /api/v1/images');
    expect(await call('post', '/api/v1/models')).toBe('api:POST /api/v1/models');
  });

  it('buckets a non-standard method', async () => {
    expect(await call('PROPFIND', '/api/v1/images')).toBe('api:OTHER /api/v1/images');
  });
});

describe('tRPC procedure label through publicProcedure', () => {
  const caller = createCallerFactory(
    router({
      labelled: router({
        probe: publicProcedure.query(async () => {
          await sleep(1);
          return routeNow();
        }),
      }),
    })
  )({
    user: undefined,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: {},
    track: {},
    ip: '127.0.0.1',
    cache: {},
    req: undefined,
    res: undefined,
  } as never);

  it('labels the resolver with trpc:<path>', async () => {
    expect(await caller.labelled.probe()).toBe('trpc:labelled.probe');
  });
});
