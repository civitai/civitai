import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a Flipt-backed flag falls back to when Flipt cannot answer.
 *
 * `hasFeature` consults Flipt first, but a null answer (module unavailable, eval
 * timeout, key absent) falls through to static evaluation of the registry's
 * `availability`. That static value is therefore the flag's behaviour during a
 * Flipt outage — the one moment nobody can turn the feature off.
 *
 * The regression this pins: `flux2Training` declared `availability: ['public']`
 * while every deployment that serves it pins it to moderators. Nothing was
 * visibly wrong, because the deployment's env override also removes the flag
 * from Flipt's control; the hazard only appears once that override is dropped
 * and Flipt goes down, at which point Flux.2 training is open to every
 * anonymous visitor. Sibling training flags (`qwenTraining`,
 * `zimageturboTraining`, …) already declare `['mod']`.
 *
 * Scope: this asserts the FALLBACK path only. It says nothing about who Flipt
 * grants the flag to when Flipt IS answering — that is the `testers` segment's
 * job and is not observable from here.
 *
 * Only the Flipt edge (`~/server/flipt/client`) is stubbed; the registry and
 * `hasFeature` run for real.
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
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';

const moderator = { id: 101, isModerator: true, tier: 'free' } as SessionUser;
const regularUser = { id: 202, isModerator: false, tier: 'free' } as SessionUser;
// `getFeatureFlags` memoizes per context, so the warm-up below must not share an
// id with any assertion — otherwise the moderator case reads a cached result and
// never re-enters `hasFeature`.
const warmupUser = { id: 909, isModerator: true, tier: 'free' } as SessionUser;

beforeAll(async () => {
  // Force the service's lazy `_fliptModule` to resolve to the mock above, so
  // `hasFeature` takes the Flipt branch and falls through on null — rather than
  // the "module never loaded" path, which reaches the same static code by a
  // different route and would leave the branch under test unexercised.
  mockIsFliptSync.mockReturnValue(null);
  await getFeatureFlagsAsync({ user: warmupUser });
});

beforeEach(() => {
  mockIsFliptSync.mockReset();
  mockIsFliptSync.mockReturnValue(null);
});

describe('static fallback while Flipt is unavailable', () => {
  it('INSTRUMENT CONTROL: Flipt is consulted and answers null, so the static path decides', async () => {
    await getFeatureFlagsAsync({});
    expect(mockIsFliptSync).toHaveBeenCalledWith('flux2-training', 'anonymous', expect.anything());
    expect(mockIsFliptSync.mock.results.every((r) => r.value === null)).toBe(true);
  });

  it('POSITIVE CONTROL: a genuinely public training flag still reaches an anonymous visitor', async () => {
    // Without this, an `flux2Training === false` below would be indistinguishable
    // from a harness that grants nothing at all.
    const features = await getFeatureFlagsAsync({});
    expect(features.kohyaTraining).toBe(true);
  });

  // `FeatureAccess` is SPARSE: a denied flag is absent, not `false`. Asserting
  // absence alone would also pass if the key were deleted from the registry
  // outright — the moderator case below is what rules that out.
  it('does not grant flux2Training to an anonymous visitor', async () => {
    const features = await getFeatureFlagsAsync({});
    expect(features).not.toHaveProperty('flux2Training');
  });

  it('does not grant flux2Training to a logged-in non-moderator', async () => {
    const features = await getFeatureFlagsAsync({ user: regularUser });
    expect(features).not.toHaveProperty('flux2Training');
  });

  it('still grants flux2Training to a moderator', async () => {
    const features = await getFeatureFlagsAsync({ user: moderator });
    expect(features.flux2Training).toBe(true);
  });
});
