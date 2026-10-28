import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';
import type * as PostIntentService from '~/server/services/post-intent/post-intent.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const svc = vi.hoisted(() => ({ stageIntent: vi.fn(), publishIntent: vi.fn() }));

vi.mock('~/server/services/post-intent/post-intent.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostIntentService>()),
  stageIntent: svc.stageIntent,
  publishIntent: svc.publishIntent,
}));

const { postIntentRouter } = await import('~/server/routers/post-intent.router');
const { PostIntentRefusal } = await import('~/server/services/post-intent/post-intent.logic');

const ctx = (features: Record<string, boolean>) =>
  ({
    user: { id: 7, onboarding: OnboardingSteps.Buzz, muted: false, emailVerified: new Date() },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { trpcFlagGuardPerRequest: true, ...features },
    req: { headers: { host: 'civitai.com' } },
    res: { setHeader: () => undefined },
  } as never);

const manifestUrl = 'https://games.civitai.com/api/share/sh_1.json';

beforeEach(() => {
  vi.clearAllMocks();
  svc.stageIntent.mockResolvedValue({ manifestUrl, media: [] });
});

describe('postIntent router', () => {
  it('refuses app mode while the flag is off, before any fetch', async () => {
    await expect(
      postIntentRouter.createCaller(ctx({ appPostIntent: false })).stage({ manifestUrl })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(svc.stageIntent).not.toHaveBeenCalled();
  });

  it('stages for the signed-in user, on the host they are on, when the flag is on', async () => {
    await postIntentRouter.createCaller(ctx({ appPostIntent: true })).stage({ manifestUrl });
    expect(svc.stageIntent).toHaveBeenCalledWith({
      manifestUrl,
      userId: 7,
      requestHost: 'civitai.com',
    });
  });

  it('reports a second post as a conflict', async () => {
    svc.publishIntent.mockRejectedValue(new PostIntentRefusal('already-posted', 'posted'));
    await expect(
      postIntentRouter
        .createCaller(ctx({ appPostIntent: true }))
        .publish({ manifestUrl, publish: true })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'posted' });
  });
});
