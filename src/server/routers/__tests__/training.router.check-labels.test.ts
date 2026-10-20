import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlags from '~/server/services/feature-flags.service';

/** `training.checkLabels`, which the trainer calls before uploading a dataset (real rule, classifier
 *  mocked): what it answers, and that the per-user budget is spent before the classifier runs. */

const classifyPromptExternally = vi.hoisted(() =>
  vi.fn(async (_prompt: string, _source?: string) => ({
    categories: [] as string[],
    externalError: null,
  }))
);
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ classifyPromptExternally }));
const rate = vi.hoisted(() => vi.fn());
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({ checkFixedWindow: rate }));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => ({}),
}));

import { trainingRouter } from '~/server/routers/training.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const caller = () =>
  trainingRouter.createCaller({
    acceptableOrigin: true,
    user: { id: 7, isModerator: false, onboarding: 0xff, muted: false, bannedAt: null },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: undefined,
  } as never);

beforeEach(() => {
  classifyPromptExternally.mockClear();
  rate.mockReset().mockResolvedValue({ allowed: true });
});

describe('training.checkLabels', () => {
  it('answers ok for clean labels, having run the classifier over them', async () => {
    await expect(
      caller().checkLabels({ triggerWord: 'mystyle', captions: ['mystyle, a cat on a sofa'] })
    ).resolves.toEqual({ ok: true });
    expect(classifyPromptExternally).toHaveBeenCalledWith(
      expect.stringContaining('a cat on a sofa'),
      expect.anything()
    );
  });

  it('refuses a blocked label with its reason', async () => {
    await expect(
      caller().checkLabels({ triggerWord: 'mystyle', captions: ['mystyle, 8 year old girl'] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('blocked') });
  });

  it('refuses over the budget without running the classifier', async () => {
    rate.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    await expect(
      caller().checkLabels({ triggerWord: 'mystyle', captions: ['mystyle, a cat'] })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(classifyPromptExternally).not.toHaveBeenCalled();
  });

  it('charges the budget the Training Studio shares, keyed by user', async () => {
    await caller().checkLabels({ triggerWord: 'mystyle', captions: ['mystyle, a cat'] });
    const [key] = rate.mock.calls[0] as [string];
    expect(key).toMatch(/^training:text-check-rate-limit:7$/);
  });
});
