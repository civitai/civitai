import { instrumentationRegistry } from '@civitai/telemetry/client';
import type client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { usePagesManifestFixture } from '~/server/utils/__tests__/pages-manifest.fixture';

// Drives the real `publicProcedure` chain, so the assertions cover the middleware wiring in
// `~/server/trpc`, not just the helper. The switch is read at module load, so each case
// re-imports under its own env. The OFF case must run first: it asserts the registry is still
// empty.

const NAME = 'civitai_app_trpc_caller_seconds_total';

function ctxFor(
  user: Record<string, unknown> | null,
  headers: Record<string, string>,
  extra: Record<string, unknown> = {}
) {
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
    ...extra,
  } as never;
}

const sleep = () => new Promise((resolve) => setTimeout(resolve, 5));

async function loadCaller(flag: 'true' | 'false') {
  vi.stubEnv('TRPC_CALLER_METRICS', flag);
  vi.resetModules();
  const { createCallerFactory, publicProcedure, router } = await import('~/server/trpc');
  const appRouter = router({
    probe: router({
      // A measurable duration, so the seconds assertion cannot pass on a zero.
      ping: publicProcedure.query(async () => {
        await sleep();
        return 'pong';
      }),
      // Distinct paths, so each case below reads only its own row.
      fail: publicProcedure.query(async () => {
        await sleep();
        throw new Error('boom');
      }),
      internal: publicProcedure.query(async () => {
        await sleep();
        return 'pong';
      }),
      keyed: publicProcedure.query(async () => {
        await sleep();
        return 'pong';
      }),
    }),
  });
  return createCallerFactory(appRouter);
}

async function secondsFor(path: string) {
  return Object.fromEntries(
    (await rows())
      .filter((r) => (r.labels as { path: string }).path === path)
      .map((r) => [(r.labels as { caller: string }).caller, r.value])
  );
}

async function rows() {
  const metric = instrumentationRegistry.getSingleMetric(NAME) as
    | client.Counter<string>
    | undefined;
  return metric ? ((await metric.get()).values as { value: number; labels: object }[]) : [];
}

beforeEach(() => {
  usePagesManifestFixture();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('publicProcedure records caller-class seconds only when TRPC_CALLER_METRICS is on', () => {
  it('OFF: a procedure call registers and records nothing', async () => {
    // Precondition: nothing in this worker registered it first, so absence below means something.
    expect(instrumentationRegistry.getSingleMetric(NAME)).toBeUndefined();

    const createCaller = await loadCaller('false');
    await createCaller(ctxFor({ id: 1 }, { 'user-agent': 'Mozilla/5.0' })).probe.ping();
    await createCaller(ctxFor(null, { 'user-agent': 'curl/8.4.0' })).probe.ping();

    expect(instrumentationRegistry.getSingleMetric(NAME)).toBeUndefined();
    expect(await instrumentationRegistry.metrics()).not.toContain('trpc_caller_seconds');
  });

  it('ON: each call adds its duration under its procedure path and caller class', async () => {
    const createCaller = await loadCaller('true');
    await createCaller(ctxFor({ id: 1 }, { 'user-agent': 'Mozilla/5.0' })).probe.ping();
    await createCaller(ctxFor(null, { 'user-agent': 'curl/8.4.0' })).probe.ping();
    await createCaller(ctxFor(null, { 'user-agent': 'curl/8.4.0' })).probe.ping();

    const out = (await rows()).filter((r) => (r.labels as { path: string }).path === 'probe.ping');
    expect(out.map((r) => r.labels)).toEqual(
      expect.arrayContaining([
        { path: 'probe.ping', caller: 'session' },
        { path: 'probe.ping', caller: 'anon_tool_ua' },
      ])
    );
    expect(out).toHaveLength(2);
    const byCaller = Object.fromEntries(
      out.map((r) => [(r.labels as { caller: string }).caller, r.value])
    );
    // Each call sleeps >= 5 ms; a timer can fire a little early, so allow 4 ms per call.
    expect(byCaller.session).toBeGreaterThanOrEqual(0.004);
    expect(byCaller.anon_tool_ua).toBeGreaterThanOrEqual(0.008);
    expect(await instrumentationRegistry.metrics()).toContain(`# TYPE ${NAME} counter`);
  });

  it('ON: a procedure that throws still adds its duration for its caller', async () => {
    // tRPC turns a resolver throw into a resolved `{ ok: false }` result, so this pins that a
    // failed call is recorded on the settle path, not skipped as a non-success.
    const createCaller = await loadCaller('true');
    await expect(
      createCaller(ctxFor(null, { 'user-agent': 'curl/8.4.0' })).probe.fail()
    ).rejects.toThrow('boom');

    const byCaller = await secondsFor('probe.fail');
    expect(Object.keys(byCaller)).toEqual(['anon_tool_ua']);
    expect(byCaller.anon_tool_ua).toBeGreaterThanOrEqual(0.004);
  });

  it('ON: a context with cache: null counts as internal, whoever the viewer is', async () => {
    const createCaller = await loadCaller('true');
    await createCaller(
      ctxFor({ id: 1 }, { 'user-agent': 'Mozilla/5.0' }, { cache: null })
    ).probe.internal();

    const byCaller = await secondsFor('probe.internal');
    expect(Object.keys(byCaller)).toEqual(['internal']);
    expect(byCaller.internal).toBeGreaterThanOrEqual(0.004);
  });

  it('ON: a context with an API key id counts as api_key', async () => {
    const createCaller = await loadCaller('true');
    await createCaller(
      ctxFor(null, { 'user-agent': 'Mozilla/5.0' }, { apiKeyId: 42 })
    ).probe.keyed();

    const byCaller = await secondsFor('probe.keyed');
    expect(Object.keys(byCaller)).toEqual(['api_key']);
    expect(byCaller.api_key).toBeGreaterThanOrEqual(0.004);
  });
});
