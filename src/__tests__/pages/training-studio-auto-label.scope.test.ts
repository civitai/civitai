import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AutoLabelService from '~/server/services/training-studio-auto-label.service';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

/** Which credentials the standalone Studio's auto-label endpoint serves, through its real account
 *  gates: a browser session or a full-scope personal key. A narrower key, even one holding the AI
 *  Services scope the embed's procedures ask for, never starts system-paid work here. */

const service = vi.hoisted(() => ({
  submit: vi.fn(async (_input: unknown) => ({ workflowId: 'wf-1' })),
  poll: vi.fn(async (_input: unknown) => ({ done: true, results: [] })),
}));
vi.mock('~/server/services/training-studio-auto-label.service', async (importOriginal) => ({
  STUDIO_AUTO_LABEL_RATE_LIMITS: (await importOriginal<typeof AutoLabelService>())
    .STUDIO_AUTO_LABEL_RATE_LIMITS,
  submitStudioAutoLabel: service.submit,
  pollStudioAutoLabel: service.poll,
}));
vi.mock('~/server/utils/rate-limit-bucket', () => ({
  claimRateLimitAttempt: vi.fn(async () => async () => undefined),
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { TRAINING_STUDIO: 'trainingStudio' },
  ensureFliptInitialized: vi.fn(async () => undefined),
  isFliptSync: vi.fn(() => true),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlagsLazy: vi.fn(() => ({})),
  computeUserFeatureFlagsOverlay: vi.fn(() => ({})),
  getFliptGatedEligibility: vi.fn(() => ({})),
}));
vi.mock('~/server/services/user.service', () => ({
  getUserSettings: vi.fn(async () => ({ features: {} })),
}));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  handleEndpointError: (await importOriginal<typeof EndpointHelpers>()).handleEndpointError,
  AuthedEndpoint:
    (handler: (req: unknown, res: unknown, user: unknown) => unknown) =>
    (req: unknown, res: unknown) =>
      handler(req, res, {
        id: 7,
        onboarding: OnboardingSteps.Buzz,
        emailVerified: new Date(),
      }),
}));

import handler from '~/pages/api/training-studio/auto-label';

const submitBody = {
  mode: 'tag',
  media: 'image',
  items: [{ mediaUrl: 'https://orchestration.civitai.com/v2/consumer/blobs/a.png', key: 'a' }],
};

const userKey = (tokenScope: number) => ({
  headers: { authorization: 'Bearer k' },
  context: {
    apiKeyId: 1,
    apiKeyType: ApiKeyType.User,
    subject: { type: 'apiKey', id: 1 },
    tokenScope,
  },
});
const session = { headers: {}, context: {} };

async function call(method: 'POST' | 'GET', credential: { headers: object; context: object }) {
  const req =
    method === 'POST'
      ? { method, query: {}, body: submitBody, ...credential }
      : { method, query: { workflowId: 'wf-1' }, ...credential };
  const res = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json() {
      return this;
    },
    setHeader() {
      return undefined;
    },
  };
  await (handler as unknown as (req: unknown, r: typeof res) => Promise<unknown>)(req, res);
  return res.statusCode;
}

describe('/api/training-studio/auto-label credentials', () => {
  beforeEach(() => {
    service.submit.mockClear();
    service.poll.mockClear();
  });

  it.each([
    ['an AI Services read key', TokenScope.AIServicesRead],
    ['an AI Services write key', TokenScope.AIServicesWrite],
  ])('refuses %s, before any work', async (_l, scope) => {
    expect(await call('POST', userKey(scope))).toBe(403);
    expect(await call('GET', userKey(scope))).toBe(403);
    expect(service.submit).not.toHaveBeenCalled();
    expect(service.poll).not.toHaveBeenCalled();
  });

  it('serves a full-scope personal key', async () => {
    expect(await call('POST', userKey(TokenScope.Full))).toBe(200);
    expect(await call('GET', userKey(TokenScope.Full))).toBe(200);
  });

  it('serves a browser session', async () => {
    expect(await call('POST', session)).toBe(200);
    expect(await call('GET', session)).toBe(200);
    expect(service.submit).toHaveBeenCalledTimes(1);
  });
});
