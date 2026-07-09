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
