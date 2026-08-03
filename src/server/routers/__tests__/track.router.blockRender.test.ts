import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Blocks Analytics Phase 2 — `track.blockRender` router coverage.
 *
 * Drives the REAL track router (via createCaller) so the publicProcedure
 * middleware chain is what runs; `ctx.track` is a stub whose `blockRender`
 * method is asserted. Pins the security-critical contract:
 *   - `isAnon` is derived SERVER-SIDE from `ctx.user` (true when null/undefined,
 *     false when a session user is present) — the client cannot set it.
 *   - The client cannot OVERRIDE isAnon: even when the wire payload smuggles
 *     `isAnon`/`userId`, the schema strips them and the procedure recomputes
 *     `isAnon` from the session.
 *   - The three identifiers (appBlockId / blockInstanceId / slotId) pass through
 *     verbatim; bad shapes are rejected by the schema (no Tracker call).
 *   - publicProcedure: anon viewers (the whole point of the event) can emit.
 */

// trpc.ts imports the redis client at module load; mock it so the suite doesn't
// pull in a real connection. needsUpdate() short-circuits to false for our
// non-'web' x-client header, so these stubs are never actually exercised.
vi.mock('~/server/redis/client', () => ({
  sysRedis: { hGetAll: vi.fn(async () => ({})) },
  withSysReadDeadline: (p: Promise<unknown>) => p,
  REDIS_SYS_KEYS: { CLIENT: 'system:client' },
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { trackRouter } from '../track.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const mockBlockRender = vi.fn();

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    // x-client !== 'web' → enforceClientVersion's needsUpdate() returns false
    // before touching sysRedis.
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    // applyDomainFeature reads ctx.features.canViewNsfw.
    features: { canViewNsfw: false } as never,
    track: { blockRender: mockBlockRender } as never,
  };
}

// A FRESH object per call — the publicProcedure's applyDomainFeature middleware
// mutates the raw input object IN PLACE (injects a browsingLevel cap) before the
// zod parse strips it, so a shared constant would get polluted across tests.
const validInput = () => ({
  appBlockId: 'ab_abc123',
  blockInstanceId: 'page_ab_abc123',
  slotId: 'app.page',
});

describe('track.blockRender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // NOTE on toMatchObject: the publicProcedure chain's applyDomainFeature
  // middleware mutates the RAW input in place (injecting a browsingLevel cap)
  // before the input zod parse runs. The blockRenderSchema strips browsingLevel
  // from the PARSED input the resolver sees (verified: the schema is non-strict,
  // unknown keys are dropped), so no stray field reaches ClickHouse in prod.
  // Under createCaller the raw-mutated object can surface alongside, so we assert
  // the load-bearing fields with toMatchObject rather than an exact deep-equal.

  it('stamps isAnon=true when there is no session user (anon viewer)', async () => {
    const caller = trackRouter.createCaller(fakeCtx(undefined) as never);
    await caller.blockRender(validInput());

    expect(mockBlockRender).toHaveBeenCalledTimes(1);
    // Exact: the schema strips middleware-injected extras (e.g. browsingLevel),
    // so ONLY the three identifiers + the server-stamped isAnon reach the Tracker.
    expect(mockBlockRender).toHaveBeenCalledWith({ ...validInput(), isAnon: true });
  });

  it('stamps isAnon=false when a session user is present', async () => {
    const caller = trackRouter.createCaller(fakeCtx({ id: 42 }) as never);
    await caller.blockRender(validInput());

    expect(mockBlockRender).toHaveBeenCalledTimes(1);
    expect(mockBlockRender).toHaveBeenCalledWith({ ...validInput(), isAnon: false });
  });

  it('forwards the three identifiers verbatim', async () => {
    const caller = trackRouter.createCaller(fakeCtx({ id: 7 }) as never);
    await caller.blockRender({
      appBlockId: 'ab_x',
      blockInstanceId: 'inst_y',
      slotId: 'model.sidebar_top',
    });

    expect(mockBlockRender).toHaveBeenCalledWith({
      appBlockId: 'ab_x',
      blockInstanceId: 'inst_y',
      slotId: 'model.sidebar_top',
      isAnon: false,
    });
  });

  it('does NOT let the client override isAnon (schema strips it; server recomputes)', async () => {
    // A logged-in client smuggles isAnon:true + a userId. The schema drops both
    // unknown keys, and the procedure recomputes isAnon from ctx.user → false.
    const caller = trackRouter.createCaller(fakeCtx({ id: 99 }) as never);
    await caller.blockRender({ ...validInput(), isAnon: true } as never);

    expect(mockBlockRender).toHaveBeenCalledTimes(1);
    const arg = mockBlockRender.mock.calls[0][0];
    // The procedure recomputes isAnon from ctx.user — the client's isAnon:true
    // (smuggled into the body) does NOT win; the server sets it to false.
    expect(arg.isAnon).toBe(false);
    // And the inverse: an anon client smuggling isAnon:false can't fake an authed render.
    mockBlockRender.mockClear();
    const anonCaller = trackRouter.createCaller(fakeCtx(undefined) as never);
    await anonCaller.blockRender({ ...validInput(), isAnon: false } as never);
    expect(mockBlockRender.mock.calls[0][0].isAnon).toBe(true);
  });

  /**
   * 🔴 The `secondary` (follow-up) beacon must NOT write a `blockRenders` row on
   * THIS path either. `blockRenders` counts IMPRESSIONS — one row per host mount
   * — and its rows carry no status, so a duplicate would be byte-identical and
   * undedupable. The REST beacon route gates this; if the tRPC procedure did not,
   * a bearer/API-key caller could reintroduce exactly the double-count the beacon
   * route prevents. That makes this the security-relevant branch, so it is pinned
   * here rather than left to the REST tests.
   */
  it('🔴 suppresses the Tracker insert for a `secondary` follow-up beacon', async () => {
    const caller = trackRouter.createCaller(fakeCtx({ id: 1 }) as never);
    await caller.blockRender({
      ...validInput(),
      status: 'error',
      errorClass: 'token_lost_midsession',
      secondary: true,
    } as never);

    expect(mockBlockRender).not.toHaveBeenCalled();
  });

  it('🔴 still writes the row for a LAUNCH failure (secondary defaults to false)', async () => {
    // The discriminator is the FLAG, not `status === 'error'`. A mount's only
    // beacon represents a real attempted render and must keep being recorded.
    const caller = trackRouter.createCaller(fakeCtx({ id: 1 }) as never);
    await caller.blockRender({
      ...validInput(),
      status: 'error',
      errorClass: 'no_token',
    } as never);

    expect(mockBlockRender).toHaveBeenCalledTimes(1);
    const arg = mockBlockRender.mock.calls[0][0];
    // status/errorClass/secondary are all stripped — none is a ClickHouse column.
    expect(arg).not.toHaveProperty('status');
    expect(arg).not.toHaveProperty('errorClass');
    expect(arg).not.toHaveProperty('secondary');
  });

  /**
   * 🔴 THE TWO-WRITE-PATH HAZARD, PINNED ON THE PATH THAT IS EASY TO FORGET.
   *
   * `blockRenders` has TWO writers: the REST beacon (/api/track/block-render)
   * and this tRPC procedure. The REST one is also the only PROM writer, which
   * inverts the intuition: a new observability field added to the shared
   * `blockRenderSchema` and stripped only in the REST handler does NOT get
   * caught here by a missing metric — it falls straight through this
   * procedure's spread into the ClickHouse insert.
   *
   * And TypeScript cannot catch it. `ctx.track.blockRender({ ...payload, isAnon })`
   * is a SPREAD, and spread properties are exempt from excess-property checking,
   * so an extra field compiles cleanly against `Tracker.blockRender`'s
   * four-field parameter type.
   *
   * MUTATION-CHECKED: restoring this resolver's previous
   * `const { status, errorClass, secondary, ...renderData } = input` — i.e.
   * patching ONLY the REST path — makes this test fail with
   * `expected { …, timings: {…} } to not have property "timings"`.
   */
  it('🔴 strips `timings` from the ClickHouse payload on the tRPC path too', async () => {
    const caller = trackRouter.createCaller(fakeCtx({ id: 5 }) as never);
    await caller.blockRender({
      ...validInput(),
      timings: { totalMs: 1_100, tokenMintMs: 180, frameFetchMs: 320, initWaitMs: 700 },
    } as never);

    expect(mockBlockRender).toHaveBeenCalledTimes(1);
    const arg = mockBlockRender.mock.calls[0][0];
    expect(arg).not.toHaveProperty('timings');
    // Byte-identical to a timing-less beacon: the CH row is unchanged.
    expect(arg).toEqual({ ...validInput(), isAnon: false });
  });

  /**
   * The companion assertion, and the one that makes the strip above meaningful:
   * this procedure must ALSO not observe the launch histograms. It is a second
   * ClickHouse writer, NOT a second metrics writer — only the REST beacon
   * increments prom. If someone "fixes the asymmetry" by adding an emit here,
   * every bearer/API-key caller starts contributing launch samples that no host
   * measured, and the ok-only / non-secondary gating that lives in the REST
   * route would be bypassed entirely.
   */
  it('🔴 does NOT observe the launch histograms (this path is a CH writer, not a metrics writer)', async () => {
    const client = (await import('prom-client')).default;
    const readCount = async () => {
      const metric = client.register.getSingleMetric('civitai_app_block_launch_total_seconds');
      if (!metric) return 0;
      const data = await (
        metric as unknown as {
          get(): Promise<{
            values: Array<{ metricName?: string; labels: Record<string, string>; value: number }>;
          }>;
        }
      ).get();
      return data.values
        .filter((v) => v.metricName === 'civitai_app_block_launch_total_seconds_count')
        .reduce((acc, v) => acc + v.value, 0);
    };

    const before = await readCount();
    const caller = trackRouter.createCaller(fakeCtx({ id: 5 }) as never);
    await caller.blockRender({
      ...validInput(),
      timings: { totalMs: 1_100 },
    } as never);
    expect(await readCount()).toBe(before);
  });

  it('rejects a missing identifier with a BAD_REQUEST and no Tracker call', async () => {
    const caller = trackRouter.createCaller(fakeCtx({ id: 1 }) as never);
    await expect(
      caller.blockRender({ appBlockId: '', blockInstanceId: 'i', slotId: 'app.page' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockBlockRender).not.toHaveBeenCalled();
  });

  it('rejects a non-string identifier with a BAD_REQUEST and no Tracker call', async () => {
    const caller = trackRouter.createCaller(fakeCtx({ id: 1 }) as never);
    await expect(
      caller.blockRender({ appBlockId: 123, blockInstanceId: 'i', slotId: 'app.page' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockBlockRender).not.toHaveBeenCalled();
  });
});
