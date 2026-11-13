import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';

/**
 * The embed's auto-label procedures must rate-limit in the standalone endpoint's bucket, with its
 * rules: that is what makes the two surfaces one allowance. Driven through the real router with a
 * caller on `trainingRouter` alone, whose paths lack the `training.` prefix, so a procedure that fell
 * back to its path-derived key would land in a different bucket and fail here.
 * `~/env/other` is mocked to production, or the limiter exempts the test env and nothing is counted.
 */

const h = vi.hoisted(() => ({
  hSetWithTTL: vi.fn(async () => undefined),
  submit: vi.fn(async () => ({ workflowId: 'wf-1' })),
  poll: vi.fn(async () => ({ done: true, results: [] })),
}));
vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isDev: false,
  isTest: false,
  isPreview: false,
  isProd: true,
}));
vi.mock('~/server/redis/atomic', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hSetWithTTL: h.hSetWithTTL,
}));
vi.mock('~/server/services/account-standing.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAccountMuted: vi.fn(async () => false),
}));
vi.mock('~/server/services/training.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAutoLabelUploadUrl: vi.fn(async () => ({ url: 'u' })),
  submitAutoLabelWorkflow: vi.fn(async () => ({ workflowId: 'wf-1' })),
  getAutoLabelWorkflow: vi.fn(async () => ({ done: true })),
}));
vi.mock('~/server/services/training-studio-auto-label.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  submitStudioAutoLabel: h.submit,
  pollStudioAutoLabel: h.poll,
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import { trainingRouter } from '~/server/routers/training.router';
import { resolveUsageLimitRules } from '~/server/services/usage-limit-config.service';
import { STUDIO_AUTO_LABEL_RATE_LIMITS } from '~/server/services/training-studio-auto-label.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function caller() {
  return trainingRouter.createCaller({
    acceptableOrigin: true,
    user: {
      id: 7,
      isModerator: false,
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date(),
    },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {}, socket: { remoteAddress: '10.0.0.1' } },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {
      trpcFlagGuardPerRequest: true,
      trainingStudioUi: true,
      imageTraining: true,
      trainingAutoLabelOrchestrator: true,
    },
    track: undefined,
  } as never);
}

const mediaUrl = 'https://orchestration.civitai.com/v2/consumer/blobs/a.png';
const call = {
  submit: () =>
    caller().studioAutoLabelSubmit({
      mode: 'tag',
      media: 'image',
      items: [{ mediaUrl, key: 'a' }],
    }),
  poll: () => caller().studioAutoLabelPoll({ workflowId: 'wf-1' }),
};

describe("the embed's auto-label procedures draw from the shared bucket", () => {
  beforeEach(() => {
    h.hSetWithTTL.mockClear();
    redisMock.redis.packed.hGet.mockResolvedValue([]);
  });

  it.each(['submit', 'poll'] as const)('a %s is recorded under the shared key', async (which) => {
    await call[which]();
    const [, cacheKey, hashKey] = h.hSetWithTTL.mock.calls.at(-1) as unknown as [
      unknown,
      string,
      string
    ];
    expect(cacheKey).toBe(
      `${REDIS_KEYS.TRPC.LIMIT.BASE}:${STUDIO_AUTO_LABEL_RATE_LIMITS[which].key}`
    );
    expect(hashKey).toBe('user:7');
  });

  it.each(['submit', 'poll'] as const)('a %s is refused at the shared limit', async (which) => {
    const [{ limit }] = await resolveUsageLimitRules(
      STUDIO_AUTO_LABEL_RATE_LIMITS[which].rules.usageLimitIds,
      undefined
    );
    redisMock.redis.packed.hGet.mockResolvedValue(Array(limit).fill(Date.now()));
    await expect(call[which]()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    redisMock.redis.packed.hGet.mockResolvedValue(Array(limit - 1).fill(Date.now()));
    await expect(call[which]()).resolves.toBeDefined();
  });
});

// The wizard's limits, as literals: the registry supplies them, so reading the expected number from
// it would pass a wrong number or a cross-wired id.
describe("the wizard's auto-label procedures", () => {
  beforeEach(() => {
    h.hSetWithTTL.mockClear();
  });

  const wizard = {
    upload: () => caller().getAutoLabelUploadUrl({ modelId: 1 }),
    submit: () =>
      caller().submitAutoLabelWorkflow({
        modelId: 1,
        images: [{ mediaUrl, filename: 'a.png' }],
        params: { type: 'tag' },
      } as never),
    poll: () => caller().getAutoLabelWorkflow({ workflowId: 'wf-1' }),
  };

  it.each([
    ['upload', 1000, 'getAutoLabelUploadUrl'],
    ['submit', 100, 'submitAutoLabelWorkflow'],
    ['poll', 1500, 'getAutoLabelWorkflow'],
  ] as const)('caps %s at %i a minute in its own bucket', async (which, limit, path) => {
    redisMock.redis.packed.hGet.mockResolvedValue(Array(limit).fill(Date.now()));
    await expect(wizard[which]()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    redisMock.redis.packed.hGet.mockResolvedValue(Array(limit - 1).fill(Date.now()));
    await expect(wizard[which]()).resolves.toBeDefined();
    const [, cacheKey] = h.hSetWithTTL.mock.calls.at(-1) as unknown as [unknown, string];
    expect(cacheKey).toBe(`${REDIS_KEYS.TRPC.LIMIT.BASE}:${path}`);
  });
});
