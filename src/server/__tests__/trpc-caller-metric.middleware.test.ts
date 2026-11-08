import { instrumentationRegistry } from '@civitai/telemetry/client';
import type client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { usePagesManifestFixture } from '~/server/utils/__tests__/pages-manifest.fixture';

// Drives the real `publicProcedure` chain, so the assertions cover the middleware wiring in
// `~/server/trpc`, not just the helper. The switch is read when the modules load, so each case
// re-imports them under its own environment. The cases run in order: OFF first, on a registry
// that is checked to be empty, then ON.

const NAME = 'civitai_app_trpc_caller_seconds_total';

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

async function loadCaller(flag: 'true' | 'false') {
  vi.stubEnv('TRPC_CALLER_METRICS', flag);
  vi.resetModules();
  const { createCallerFactory, publicProcedure, router } = await import('~/server/trpc');
  const appRouter = router({
    probe: router({
      // A measurable duration, so the seconds assertion cannot pass on a zero.
      ping: publicProcedure.query(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'pong';
      }),
    }),
  });
  return createCallerFactory(appRouter);
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

    const out = await rows();
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
});
