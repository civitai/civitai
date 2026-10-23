import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';

/** The Training Studio's gates, shared by the token and text-check endpoints. */

const h = vi.hoisted(() => ({
  fullScope: vi.fn(() => true),
  hostFlags: vi.fn((): Record<string, boolean> => ({ trainingStudioUi: true })),
  overlay: vi.fn((): Record<string, boolean> => ({})),
}));
vi.mock('~/server/utils/require-full-scope-session', () => ({
  requireFullScopeSession: h.fullScope,
}));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlagsLazy: h.hostFlags,
  computeUserFeatureFlagsOverlay: h.overlay,
  getFliptGatedEligibility: vi.fn(() => ({})),
}));
vi.mock('~/server/services/user.service', () => ({
  getUserSettings: vi.fn(async () => ({ features: {} })),
}));

import { allowTrainingStudio } from '~/server/utils/training-studio-access';

const user = (over: Record<string, unknown> = {}) =>
  ({ id: 1, onboarding: OnboardingSteps.Buzz, emailVerified: new Date(), ...over } as never);

function res() {
  return {
    statusCode: 0,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json: vi.fn(),
  };
}

async function gate(u = user()) {
  const r = res();
  const allowed = await allowTrainingStudio({} as never, r as never, u);
  return { allowed, status: r.statusCode };
}

describe('allowTrainingStudio', () => {
  beforeEach(() => {
    h.fullScope.mockReturnValue(true);
    h.hostFlags.mockReturnValue({ trainingStudioUi: true });
    h.overlay.mockReturnValue({});
  });

  it('allows an eligible user', async () => {
    expect(await gate()).toEqual({ allowed: true, status: 0 });
  });

  it.each([
    ['banned', { bannedAt: new Date() }],
    ['not onboarded', { onboarding: 0 }],
    ['muted', { muted: true }],
    [
      'unverified when verification is required',
      { emailVerified: null, meta: { emailVerificationRequired: true } },
    ],
  ])('refuses a user who is %s', async (_l, over) => {
    expect(await gate(user(over))).toEqual({ allowed: false, status: 403 });
  });

  it('refuses a session without full scope', async () => {
    h.fullScope.mockReturnValue(false);
    expect((await gate()).allowed).toBe(false);
  });

  it('follows the per-user flag overlay, both ways', async () => {
    h.hostFlags.mockReturnValue({ trainingStudioUi: false });
    h.overlay.mockReturnValue({ trainingStudioUi: true });
    expect((await gate()).allowed).toBe(true);

    h.hostFlags.mockReturnValue({ trainingStudioUi: true });
    h.overlay.mockReturnValue({ trainingStudioUi: false });
    expect(await gate()).toEqual({ allowed: false, status: 403 });
  });

  it('skips the page flag when asked, keeping the account gates', async () => {
    h.hostFlags.mockReturnValue({ trainingStudioUi: false });
    const r = res();
    expect(await allowTrainingStudio({} as never, r as never, user(), { pageFlag: false })).toBe(
      true
    );
    expect(
      await allowTrainingStudio({} as never, res() as never, user({ muted: true }), {
        pageFlag: false,
      })
    ).toBe(false);
  });
});
