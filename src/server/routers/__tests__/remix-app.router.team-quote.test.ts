import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';
import type * as RemixAppService from '~/server/services/remix-app.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const h = vi.hoisted(() => ({
  quoteTeamRemix: vi.fn<(args: { getToken: () => Promise<string> }) => Promise<null>>(
    async () => null
  ),
  getToken: vi.fn(async () => 'orch-token'),
  startRemixRun: vi.fn(async () => ({ status: 'running' })),
  advanceRemixRun: vi.fn(async () => ({ status: 'running' })),
  postRemixResult: vi.fn(async () => ({ postId: 1 })),
}));

vi.mock('~/server/services/remix-app-run.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startRemixRun: h.startRemixRun,
  advanceRemixRun: h.advanceRemixRun,
  postRemixResult: h.postRemixResult,
}));

vi.mock('~/server/services/remix-app.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RemixAppService>()),
  quoteTeamRemix: h.quoteTeamRemix,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: h.getToken,
}));

const { remixAppRouter } = await import('~/server/routers/remix-app.router');

const user = { id: 42, isModerator: true, onboarding: OnboardingSteps.Buzz, muted: false };
const ctx = (remixApps: boolean) =>
  ({
    user,
    acceptableOrigin: true,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    // The per-request guard reads `ctx.features`, so the flag here is the one under test.
    features: { remixApps, trpcFlagGuardPerRequest: true },
    domain: 'green',
    req: { headers: {} },
    res: { setHeader: () => undefined },
  } as never);

const teamQuote = (remixApps: boolean) =>
  remixAppRouter.createCaller(ctx(remixApps)).teamQuote({ imageId: 5 });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('remixApp.teamQuote', () => {
  it('is refused with the remixApps flag off, before the service', async () => {
    await expect(teamQuote(false)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.quoteTeamRemix).not.toHaveBeenCalled();
  });

  it('leaves the orchestrator token to the service, fetched only on demand', async () => {
    await teamQuote(true);
    expect(h.quoteTeamRemix).toHaveBeenCalledTimes(1);
    const [args] = h.quoteTeamRemix.mock.calls[0];
    expect(args).toMatchObject({ imageId: 5, caller: { user, isGreenDomain: true } });
    expect(args).not.toHaveProperty('caller.token');
    expect(h.getToken).not.toHaveBeenCalled();

    await expect(args.getToken()).resolves.toBe('orch-token');
    expect(h.getToken).toHaveBeenCalledWith(42, expect.anything());
  });
});

describe('remixApp.start and advance', () => {
  const runId = 'r0123456789abcdef0123';
  it('are refused with the remixApps flag off, before the service', async () => {
    const off = remixAppRouter.createCaller(ctx(false));
    await expect(
      off.start({ slug: 'anime-it', imageId: 5, nonce: 'nonce-0001', quote: 30 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(off.advance({ runId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.startRemixRun).not.toHaveBeenCalled();
    expect(h.advanceRemixRun).not.toHaveBeenCalled();

    // POSITIVE CONTROL: the same calls with the flag on reach the service.
    const on = remixAppRouter.createCaller(ctx(true));
    await on.start({ slug: 'anime-it', imageId: 5, nonce: 'nonce-0001', quote: 30 });
    await on.advance({ runId });
    expect(h.startRemixRun).toHaveBeenCalledTimes(1);
    expect(h.advanceRemixRun).toHaveBeenCalledTimes(1);
  });
});

describe('remixApp.post', () => {
  const post = (gallery: { hostImageId: number; method: string; expectedPrice?: number }) =>
    remixAppRouter.createCaller(ctx(true)).post({ workflowId: 'wf-1', gallery } as never);

  it('refuses a paid gallery submission without the price it was shown, before the service', async () => {
    // A missing price reaches the gallery service as consent to the owner's current one.
    await expect(post({ hostImageId: 5, method: 'paid' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(h.postRemixResult).not.toHaveBeenCalled();

    // POSITIVE CONTROL: with the price, and on the free path without one, it reaches the service.
    await post({ hostImageId: 5, method: 'paid', expectedPrice: 100 });
    await post({ hostImageId: 5, method: 'free' });
    expect(h.postRemixResult).toHaveBeenCalledTimes(2);
  });
});
