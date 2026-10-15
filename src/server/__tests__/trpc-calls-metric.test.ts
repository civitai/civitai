import { instrumentationRegistry } from '@civitai/telemetry/client';
import type client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPC_CALLS_METRIC } from '~/server/prom/route-traffic.metrics';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { createCallerFactory, publicProcedure, router } from '~/server/trpc';
import { usePagesManifestFixture } from '~/server/utils/__tests__/pages-manifest.fixture';

/** Drives the real `publicProcedure` chain, so the assertion covers the wiring, not just the helper. */
const createCaller = createCallerFactory(router({ ping: publicProcedure.query(() => 'pong') }));

function ctxFor(user: Record<string, unknown> | null, headers: Record<string, string>) {
  return {
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { canViewNsfw: true },
    track: {},
    ip: '127.0.0.1',
    cache: {},
    req: { headers },
    res: undefined,
  } as never;
}

async function rows() {
  const metric = instrumentationRegistry.getSingleMetric(TRPC_CALLS_METRIC) as
    | client.Counter<string>
    | undefined;
  return metric ? (await metric.get()).values : [];
}

beforeEach(() => {
  usePagesManifestFixture();
  (
    instrumentationRegistry.getSingleMetric(TRPC_CALLS_METRIC) as client.Counter | undefined
  )?.reset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('publicProcedure counts every call by page route and sign-in state', () => {
  it('records the x-page-route header and whether a user is present', async () => {
    await createCaller(
      ctxFor({ id: 1 }, { host: 'civitai.com', 'x-page-route': '/models/[id]/[[...slug]]' })
    ).ping();
    await createCaller(ctxFor(null, { host: 'civitai.com', 'x-page-route': '/models/123' })).ping();

    expect(await rows()).toEqual(
      expect.arrayContaining([
        { value: 1, labels: { route: '/models/[id]/[[...slug]]', authed: 'true' } },
        { value: 1, labels: { route: 'other', authed: 'false' } },
      ])
    );
    expect(await rows()).toHaveLength(2);
  });
});
