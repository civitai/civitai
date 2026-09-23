import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 REGRESSION — the REST transport evaluated Flipt as an EMPTY CONTEXT.
 *
 * `blockWorkflowCaller` passed `user: undefined` and `getFeatureFlagsLazy({ req })`, so
 * `buildFliptContext` emitted `{ isLoggedIn: 'false' }` with no `userId` and no
 * `isModerator`. Flipt segments match on CONTEXT properties, so every segment missed and
 * every segment-gated flag fell back to its `enabled` default — while the bridge, for the
 * same viewer and the same action, evaluated with a real context.
 *
 * REPRODUCED against production Flipt (namespace `default`, flag `wildcards`) before this
 * guard was written, four arms:
 *   empty context                 -> enabled=false, DEFAULT, segments=[]
 *   isModerator=true              -> enabled=true,  MATCH,   segments=["moderators"]
 *   listed tester id, non-mod     -> enabled=true,  MATCH,   segments=["testers"]
 *   ordinary viewer (the CONTROL) -> enabled=false, DEFAULT, segments=[]
 * The control bounds it: an ordinary viewer got the SAME answer on both transports, so the
 * divergence was confined to moderators and listed testers. For `wildcards` that meant a
 * REFUSED generation where the bridge succeeded.
 *
 * These assertions pin the INPUT — that the caller hands Flipt the token's verified
 * subject — because the output depends on live flag state this suite cannot reach. That is
 * the half a test CAN own; the live arms above are the half it cannot, and they are
 * recorded here rather than silently assumed.
 */

const captured: { ctx?: Record<string, unknown> } = {};

vi.mock('~/server/trpc', () => ({
  createCallerFactory: () => (ctx: Record<string, unknown>) => {
    captured.ctx = ctx;
    return {} as unknown;
  },
}));
vi.mock('~/server/routers/blocks.router', () => ({ blocksRouter: {} }));
vi.mock('~/server/clickhouse/client', () => ({ Tracker: class {} }));
vi.mock('~/server/utils/client-ip', () => ({ resolveClientIpOrNull: () => '10.0.0.1' }));
vi.mock('~/server/utils/server-domain', () => ({ getRequestDomainColor: () => 'blue' }));

const getUserById = vi.fn();
vi.mock('~/server/services/user.service', () => ({ getUserById: (...a: unknown[]) => getUserById(...a) }));

// The real `parseSubjectUserId` is cheap and is the thing under test at the seam, so it is
// NOT mocked — a mock here would pin our own idea of the subject format rather than the
// middleware's.
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlagsLazy: (input: Record<string, unknown>) => ({ __input: input }),
}));

const VIEWER = 4242;

function reqWith(sub: string | undefined): NextApiRequest {
  return { headers: {}, url: '/api/v1/blocks/workflows/estimate', blockClaims: sub ? { sub } : undefined } as unknown as NextApiRequest;
}
const res = {} as NextApiResponse;

describe('the REST transport targets Flipt with the token subject, not an empty context', () => {
  beforeEach(() => {
    captured.ctx = undefined;
    getUserById.mockReset();
  });

  it('threads the verified subject id and isModerator into the flag context', async () => {
    getUserById.mockResolvedValue({ id: VIEWER, isModerator: true });
    const { blockWorkflowCaller } = await import('~/server/services/blocks/block-workflow-rest');
    await blockWorkflowCaller(reqWith(`user:${VIEWER}`), res);

    // The lookup asks for exactly the two properties Flipt segments read.
    expect(getUserById).toHaveBeenCalledWith({
      id: VIEWER,
      select: { id: true, isModerator: true },
    });
    const user = captured.ctx?.user as { id?: number; isModerator?: boolean } | undefined;
    expect(user?.id).toBe(VIEWER);
    expect(user?.isModerator).toBe(true);
    // 🔴 The load-bearing half: the SAME user reaches the feature builder. Asserting only
    // `ctx.user` would pass while `getFeatureFlagsLazy({ req })` still got no user — which
    // is precisely the defect, since Flipt reads the feature context and not `ctx.user`.
    const flagInput = (captured.ctx?.features as { __input?: { user?: { id?: number } } })?.__input;
    expect(flagInput?.user?.id).toBe(VIEWER);
  });

  it('leaves an ANON subject with no user — an empty context is CORRECT there', async () => {
    // The literal `anon`, which is what the mint issues — NOT `anon:<something>`.
    // An earlier draft of this test used `anon:abc` and went red with
    // `malformed sub claim`, which is the REAL function behaving correctly on input the
    // mint never produces. Worth keeping as a note: `parseSubjectUserId` is deliberately
    // not mocked here, and that is what surfaced the wrong fixture rather than hiding it.
    const { blockWorkflowCaller } = await import('~/server/services/blocks/block-workflow-rest');
    await blockWorkflowCaller(reqWith('anon'), res);
    expect(getUserById).not.toHaveBeenCalled();
    expect(captured.ctx?.user).toBeUndefined();
  });

  it('PROPAGATES a malformed sub rather than silently degrading to an empty context', async () => {
    // Unreachable in production — `withBlockScope` verifies the token before the handler
    // runs, so the sub is well-formed by the time we get here. Pinned because the failure
    // direction is the point: if this ever IS reachable, failing closed is right, and
    // swallowing it would reinstate the exact silent-empty-context defect this file
    // exists to prevent.
    const { blockWorkflowCaller } = await import('~/server/services/blocks/block-workflow-rest');
    await expect(blockWorkflowCaller(reqWith('anon:abc'), res)).rejects.toThrow(
      /malformed sub claim/
    );
  });

  it('leaves a request with NO claims with no user, and does not throw', async () => {
    const { blockWorkflowCaller } = await import('~/server/services/blocks/block-workflow-rest');
    await blockWorkflowCaller(reqWith(undefined), res);
    expect(getUserById).not.toHaveBeenCalled();
    expect(captured.ctx?.user).toBeUndefined();
  });
});
