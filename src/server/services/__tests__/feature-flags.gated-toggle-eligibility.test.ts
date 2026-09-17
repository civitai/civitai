import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Eligibility for Flipt-gated TOGGLEABLE flags (`getFliptGatedEligibility` +
 * `computeUserFeatureFlagsOverlay`) — the pair that decides whether
 * `/training-studio` renders or 404s for a user whose settings toggle is ON.
 *
 * The regression this pins: `trainingStudioUi` is `availability: ['mod']` with a
 * fliptKey. Inside `hasFeature` a non-null Flipt eval short-circuits the static
 * role check, so once the `training-studio-ui` flag EXISTS in Flipt, a moderator
 * outside its segment evaluated to `false` — while any Flipt miss (module not
 * loaded, eval timeout → null) fell back to the static 'mod' grant. Eligibility
 * therefore FLAPPED with Flipt health, and each flap turned the already-on
 * toggle into a FeatureLayout NotFound. Mods must be eligible for 'mod' keys
 * regardless of what Flipt answers; Flipt ramps the non-mod population.
 *
 * Only the Flipt edge (`~/server/flipt/client`) is stubbed — the registry,
 * `hasFeature`, and the overlay computation all run for real.
 */

const { mockIsFliptSync } = vi.hoisted(() => ({ mockIsFliptSync: vi.fn() }));

vi.mock('~/server/flipt/client', () => ({
  isFliptSync: (...a: unknown[]) => mockIsFliptSync(...a),
  isFlipt: vi.fn(),
  getFliptVariant: vi.fn(),
  getFliptBoolean: vi.fn(),
  ensureFliptInitialized: vi.fn(async () => undefined),
  FLIPT_FEATURE_FLAGS: {},
}));

import type { SessionUser } from '~/types/session';
import {
  computeUserFeatureFlagsOverlay,
  getFeatureFlagsAsync,
  getFliptGatedEligibility,
  type FeatureAccess,
} from '~/server/services/feature-flags.service';

const moderator = { id: 101, isModerator: true, tier: 'free' } as SessionUser;
const regularUser = { id: 202, isModerator: false, tier: 'free' } as SessionUser;

beforeAll(async () => {
  // Force the service's lazy `_fliptModule` to resolve to the mock above, so
  // `hasFeature` takes the Flipt-authoritative branch instead of the
  // "module not loaded" static fallback.
  mockIsFliptSync.mockReturnValue(null);
  await getFeatureFlagsAsync({ user: moderator });
});

beforeEach(() => {
  mockIsFliptSync.mockReset();
});

const fliptAnswers = (answers: Record<string, boolean | null>) => {
  mockIsFliptSync.mockImplementation((key: string) => answers[key] ?? null);
};

describe('getFliptGatedEligibility', () => {
  it('keeps a moderator eligible for trainingStudioUi when the Flipt segment excludes them', () => {
    fliptAnswers({ 'training-studio-ui': false });
    const eligibility = getFliptGatedEligibility({ user: moderator });
    expect(eligibility.trainingStudioUi).toBe(true);
  });

  it('keeps a moderator eligible when Flipt is unavailable (eval null → static fallback)', () => {
    fliptAnswers({ 'training-studio-ui': null });
    const eligibility = getFliptGatedEligibility({ user: moderator });
    expect(eligibility.trainingStudioUi).toBe(true);
  });

  it('lets Flipt grant a non-mod user', () => {
    fliptAnswers({ 'training-studio-ui': true });
    const eligibility = getFliptGatedEligibility({ user: regularUser });
    expect(eligibility.trainingStudioUi).toBe(true);
  });

  it('lets Flipt deny a non-mod user (segment miss is authoritative for non-mods)', () => {
    fliptAnswers({ 'training-studio-ui': false });
    const eligibility = getFliptGatedEligibility({ user: regularUser });
    expect(eligibility.trainingStudioUi).toBe(false);
  });

  it('denies a non-mod user via the static fallback when Flipt is unavailable', () => {
    fliptAnswers({ 'training-studio-ui': null });
    const eligibility = getFliptGatedEligibility({ user: regularUser });
    expect(eligibility.trainingStudioUi).toBe(false);
  });
});

describe('computeUserFeatureFlagsOverlay with gated eligibility', () => {
  const hostFeatures = {} as FeatureAccess; // toggleable default:false keys are never in host flags
  const toggledOn = { trainingStudioUi: true };

  it('retains the ON toggle for a moderator the Flipt segment excludes', () => {
    fliptAnswers({ 'training-studio-ui': false });
    const overlay = computeUserFeatureFlagsOverlay(
      toggledOn,
      hostFeatures,
      getFliptGatedEligibility({ user: moderator })
    );
    expect(overlay.trainingStudioUi).toBe(true);
  });

  it('withholds the key from an ineligible non-mod user even with the toggle ON', () => {
    fliptAnswers({ 'training-studio-ui': false });
    const overlay = computeUserFeatureFlagsOverlay(
      toggledOn,
      hostFeatures,
      getFliptGatedEligibility({ user: regularUser })
    );
    expect(overlay.trainingStudioUi).toBeUndefined();
  });

  it('retains the ON toggle for a Flipt-granted non-mod user', () => {
    fliptAnswers({ 'training-studio-ui': true });
    const overlay = computeUserFeatureFlagsOverlay(
      toggledOn,
      hostFeatures,
      getFliptGatedEligibility({ user: regularUser })
    );
    expect(overlay.trainingStudioUi).toBe(true);
  });

  it('withholds the key when eligibility is omitted — host-flag presence cannot stand in for it', () => {
    // The trap a4495fe41a fixed: a toggleable default:false key is NEVER present in
    // host flags, so the presence fallback reads "ineligible" for everyone. Any new
    // call site must thread getFliptGatedEligibility or it locks the feature out.
    const overlay = computeUserFeatureFlagsOverlay(toggledOn, hostFeatures);
    expect(overlay.trainingStudioUi).toBeUndefined();
  });
});
