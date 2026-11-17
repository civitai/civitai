import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import { OnboardingSteps } from '~/server/common/enums';

/** The answer the Training Studio's server trusts to serve its embed routes to a user outside its
 *  closed beta: the real account gates and embed page flag, with only the caller supplied. */

const flags = vi.hoisted(() => ({
  trainingStudioUi: true,
  overlay: {} as Record<string, boolean>,
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlagsLazy: vi.fn(() => ({ trainingStudioUi: flags.trainingStudioUi })),
  computeUserFeatureFlagsOverlay: vi.fn(() => flags.overlay),
  getFliptGatedEligibility: vi.fn(() => ({})),
}));
vi.mock('~/server/services/user.service', () => ({
  getUserSettings: vi.fn(async () => ({ features: {} })),
}));

const caller = vi.hoisted(() => ({ user: {} as Record<string, unknown> }));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  AuthedEndpoint:
    (handler: (req: unknown, res: unknown, user: unknown) => unknown) =>
    (req: unknown, res: unknown) =>
      handler(req, res, caller.user),
}));

import handler from '~/pages/api/training-studio/access';

const allowed = { id: 7, onboarding: OnboardingSteps.Buzz, emailVerified: new Date() };

async function call(user: Record<string, unknown>) {
  caller.user = user;
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.body = data;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  };
  const req = { method: 'GET', headers: {}, query: {} };
  await (handler as unknown as (q: unknown, r: typeof res) => Promise<unknown>)(req, res);
  return res;
}

describe('GET /api/training-studio/access', () => {
  beforeEach(() => {
    flags.trainingStudioUi = true;
    flags.overlay = {};
  });

  it('answers ok for a user the embed is open to, uncached', async () => {
    const res = await call(allowed);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it.each([
    ['a muted account', { ...allowed, muted: true }],
    ['a banned account', { ...allowed, bannedAt: new Date() }],
    ['an account that has not finished onboarding', { ...allowed, onboarding: 0 }],
  ])('refuses %s, never answering ok', async (_label, user) => {
    const res = await call(user);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toEqual({ ok: true });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('refuses a user the embed page is off for', async () => {
    flags.trainingStudioUi = false;
    const res = await call(allowed);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toEqual({ ok: true });
  });

  it('refuses a user who switched back to the classic trainer', async () => {
    flags.overlay = { trainingStudioUi: false };
    const res = await call(allowed);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toEqual({ ok: true });
  });
});
