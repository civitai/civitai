import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE SEAM. Four surfaces own one value and each is individually testable and
 * individually meaningless:
 *
 *   User.settings JSON
 *     → apps/auth `shapeSessionUser`      (the auth hub's session projection)
 *     → `SessionUser.isEarlyAdopter`      (the wire contract, packages/civitai-auth)
 *     → `buildFliptContext`               (the evaluation context)
 *     → `getFeatureFlags(...).earlyAdopter` (the flag the app actually branches on)
 *
 * A test scoped to any ONE hop passes while the chain is broken — a settings key the hub
 * does not project, or a context property the segment does not match, both look perfectly
 * healthy from inside their own file. So this drives REAL code at every hop and stubs only
 * the Flipt EDGE (`~/server/flipt/client`), whose stub doubles as the assertion point: it
 * captures the exact context the chain produced and evaluates it against a transcription of
 * the LIVE flag — BOTH its `early-adopters` segment rollout and its flag-level `enabled`.
 *
 * Modelled on `src/server/routers/__tests__/blocks.router.flag-gate-hydrate.test.ts`.
 *
 * 🔴 THE FIRST VERSION OF THIS FILE MODELLED ONLY THE SEGMENT, and that omission is exactly
 * how a deploy-blocking defect got through a green seam test. The stub returned `false` for
 * a non-matching user; real Flipt returns the flag's `enabled`. The flag shipped as
 * `enabled: true`, so in production every non-opted-in user and every anonymous request
 * would have evaluated to `true` — while this test happily asserted "OFF end-to-end". A
 * fake that disagrees with production in the direction you were hoping for is worse than no
 * fake. See `EARLY_ADOPTER_FLAG` below and the `flag-level default` describe block.
 *
 * The surface this fixture does NOT load, stated plainly: the Flipt server itself, and the
 * flipt-state YAML (a different repo). `EARLY_ADOPTER_FLAG` is a hand-written transcription
 * of that YAML, so a change to the real flag can still diverge from this test. That
 * divergence is guarded on the YAML side by `scripts/validate-flag-shape.py` in flipt-state,
 * not here.
 */

const { mockIsFliptSync } = vi.hoisted(() => ({ mockIsFliptSync: vi.fn() }));

// Only the Flipt edge is stubbed. `buildFliptContext` / `hasFeature` / the feature registry
// all run for real.
vi.mock('~/server/flipt/client', () => ({
  isFliptSync: (...a: unknown[]) => mockIsFliptSync(...a),
  isFlipt: vi.fn(),
  getFliptVariant: vi.fn(),
  getFliptBoolean: vi.fn(),
  ensureFliptInitialized: vi.fn(async () => undefined),
  FLIPT_FEATURE_FLAGS: {},
}));

import {
  shapeSessionUser,
  type ProducerUserRow,
} from '../../../../apps/auth/src/lib/server/auth/session-shape';
import { buildFliptContext, getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';

/**
 * `getFeatureFlags` memoizes the whole FeatureAccess for 10s keyed on user identity + host
 * + region, so two calls that share a key share a RESULT. Every test that evaluates flags
 * therefore needs its own user id, or it reads the previous test's answer. (The one test
 * that deliberately reuses an id does so to pin the cache key — see the last describe.)
 */
let nextUserId = 1000;
const freshId = () => ++nextUserId;

/** A `User` row as the hub's producer query returns it, with a caller-supplied settings blob. */
const userRow = (settings: unknown, id = 42): ProducerUserRow => ({
  id,
  username: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
  emailVerified: null,
  image: null,
  createdAt: new Date('2020-01-01T00:00:00Z'),
  isModerator: false,
  showNsfw: true,
  blurNsfw: false,
  browsingLevel: 7,
  onboarding: 0,
  muted: false,
  mutedAt: null,
  bannedAt: null,
  deletedAt: null,
  customerId: null,
  paddleCustomerId: null,
  autoplayGifs: null,
  leaderboardShowcase: null,
  filePreferences: {},
  settings,
  meta: {},
  profilePicture: null,
  referral: null,
});

/** settings JSON → the SessionUser a request would actually carry. Real hub code. */
function sessionUserFromSettings(settings: unknown, id = 42): SessionUser {
  return shapeSessionUser({
    row: userRow(settings, id),
    subscriptionRows: [],
    permissions: [],
    roles: [],
    tierKey: 'tier',
  }) as unknown as SessionUser;
}

/**
 * A stand-in for how Flipt actually evaluates a BOOLEAN flag. It models BOTH halves of the
 * flag definition, because the earlier version of this stub modelled only the segment and
 * was therefore structurally unable to see the defect that shipped in flipt-state#62:
 *
 *   1. the segment rollout — match ⇒ the rollout's `value`
 *   2. `enabled` — the value returned when NO rollout matches
 *
 * 🔴 `enabled` is NOT a master switch. Measured on prod Flipt v2.10.0 (2026-08-15):
 *      oauth-apps / comic-creator / api-key-buzz-limit (enabled:true + segment rollout)
 *        → non-matching entity gets `true`, DEFAULT_EVALUATION_REASON, segmentKeys=[]
 *      app-blocks-enabled / buzz-memberships (enabled:false + segment rollout)
 *        → non-matching gets `false`; a MATCHING entity still gets `true` / MATCH
 * A stub that returns `false` for a non-match hard-codes the answer we hoped for and
 * agrees with production only by luck of the flag being written correctly.
 */
type BooleanFlagShape = {
  /** The no-match DEFAULT. Mirrors `enabled:` in flipt-state features.yaml. */
  enabled: boolean;
  rollout: { matches: (ctx?: Record<string, string>) => boolean; value: boolean };
};

/**
 * Mirrors the `early-adopter` flag as defined in
 * flipt-state `civitai-app/default/features.yaml`. Both fields are transcribed from the
 * YAML, not from `buildFliptContext` — so if the context stopped emitting the exact string
 * the segment wants, or if the flag's `enabled` were flipped, this goes red.
 */
const EARLY_ADOPTER_FLAG: BooleanFlagShape = {
  enabled: false,
  rollout: {
    // constraint: STRING_COMPARISON_TYPE / property isEarlyAdopter / eq / "true"
    matches: (ctx) => ctx?.isEarlyAdopter === 'true',
    value: true,
  },
};

/** Flipt's boolean evaluation: first matching rollout wins, else the flag's `enabled`. */
function evaluateBoolean(shape: BooleanFlagShape, ctx?: Record<string, string>): boolean {
  return shape.rollout.matches(ctx) ? shape.rollout.value : shape.enabled;
}

const req = { headers: {} } as never;

/**
 * A request with a UNIQUE host, and therefore a unique `featureAccessKey`.
 *
 * Needed for anonymous cases: with no user the key degenerates to `anon|h:<host>|r:`, so
 * every anonymous test in this file would otherwise share ONE memo entry and read whichever
 * test ran first. (That sharing is correct in production — all anonymous callers really are
 * interchangeable for flag purposes — which is exactly why the tests have to vary the host
 * rather than the code being "fixed".) Host is safe to vary here: the flag declares no
 * server availability, so `serverMatch` is true for any host.
 */
let nextHost = 0;
const freshReq = () => ({ headers: { host: `t${++nextHost}.test.invalid` } } as never);

/** Install the Flipt stub, optionally overriding the flag's shape for a single test. */
function stubFlipt(shape: BooleanFlagShape = EARLY_ADOPTER_FLAG) {
  mockIsFliptSync.mockImplementation(
    (flag: string, _entityId: string, ctx?: Record<string, string>) =>
      flag === 'early-adopter' ? evaluateBoolean(shape, ctx) : null
  );
}

beforeEach(() => {
  mockIsFliptSync.mockReset();
  stubFlipt();
});

describe('early-adopter seam: User.settings → hub session → Flipt context', () => {
  it('an opt-in in the settings JSON reaches the Flipt context as the string "true"', () => {
    const user = sessionUserFromSettings({ isEarlyAdopter: true });
    // Hop 2 actually carried it — a settings key the hub silently drops would die here.
    expect(user.isEarlyAdopter).toBe(true);
    // Hop 3 emitted the exact literal the segment matches.
    expect(buildFliptContext(user).isEarlyAdopter).toBe('true');
  });

  it('a user who never opted in reaches the context as "false"', () => {
    const user = sessionUserFromSettings({});
    expect(user.isEarlyAdopter).toBeUndefined();
    expect(buildFliptContext(user).isEarlyAdopter).toBe('false');
  });

  it('an unrelated settings blob does not accidentally enrol anyone', () => {
    const user = sessionUserFromSettings({ allowAds: false, dismissedAlerts: ['x'] });
    expect(buildFliptContext(user).isEarlyAdopter).toBe('false');
    expect(EARLY_ADOPTER_FLAG.rollout.matches(buildFliptContext(user))).toBe(false);
  });
});

describe('early-adopter seam: the full chain decides the flag', () => {
  it('the flag is ON end-to-end for an opted-in user', async () => {
    const id = freshId();
    const user = sessionUserFromSettings({ isEarlyAdopter: true }, id);
    const features = await getFeatureFlagsAsync({ user, req });

    expect(features.earlyAdopter).toBe(true);

    // And it got there via a context the real chain built — not via static availability.
    const call = mockIsFliptSync.mock.calls.find((c) => c[0] === 'early-adopter');
    expect(call).toBeDefined();
    const [, entityId, ctx] = call as [string, string, Record<string, string>];
    expect(entityId).toBe(String(id));
    expect(ctx.isEarlyAdopter).toBe('true');
  });

  it('the flag is OFF end-to-end for a user who did not opt in', async () => {
    const user = sessionUserFromSettings({}, freshId());
    const features = await getFeatureFlagsAsync({ user, req });

    expect(features.earlyAdopter).toBeFalsy();
    const call = mockIsFliptSync.mock.calls.find((c) => c[0] === 'early-adopter');
    expect((call as [string, string, Record<string, string>])[2].isEarlyAdopter).toBe('false');
  });

  it('FAILS CLOSED when Flipt has no answer — an opt-in alone does not grant the flag', async () => {
    // `availability: []` on the registry entry means static evaluation is false. So a Flipt
    // outage (or a missing flag) must leave an opted-in user OUT of the cohort rather than
    // handing the feature to them ungated. This is the branch that would silently invert if
    // someone "helpfully" widened availability to ['user'].
    mockIsFliptSync.mockImplementation(() => null);

    const user = sessionUserFromSettings({ isEarlyAdopter: true }, freshId());
    const features = await getFeatureFlagsAsync({ user, req });

    expect(features.earlyAdopter).toBeFalsy();
  });

  it('an anonymous request is never in the cohort', async () => {
    const features = await getFeatureFlagsAsync({ user: undefined, req: freshReq() });
    expect(features.earlyAdopter).toBeFalsy();
  });

  it('the opt-in does not leak into a neighbouring Flipt-backed flag', async () => {
    // `earlyAdopter` must not be a general privilege escalation: a flag gated on `mod`
    // stays off for an opted-in non-mod.
    const user = sessionUserFromSettings({ isEarlyAdopter: true }, freshId());
    const features = await getFeatureFlagsAsync({ user, req });
    expect(features.earlyAdopter).toBe(true);
    expect(features.oauthApps).toBeFalsy();
  });
});

describe("early-adopter seam: the flag's `enabled` is the NO-MATCH DEFAULT", () => {
  // These are the tests the original stub could not express, and their absence is what let
  // an inverted flag definition pass a green seam suite.

  it('the transcribed flag is `enabled: false` — the only shape that scopes the cohort', () => {
    // Pinned as a literal against the flipt-state YAML. If someone "turns the flag on" by
    // setting enabled:true, this is the first thing that goes red.
    expect(EARLY_ADOPTER_FLAG.enabled).toBe(false);
    expect(EARLY_ADOPTER_FLAG.rollout.value).toBe(true);
  });

  it('a non-matching entity receives the flag-level default, not a hard-coded false', () => {
    // Direct assertion on the evaluator, so the stub's own semantics are under test rather
    // than merely assumed by the tests that consume it.
    expect(evaluateBoolean(EARLY_ADOPTER_FLAG, { isEarlyAdopter: 'false' })).toBe(false);
    expect(evaluateBoolean(EARLY_ADOPTER_FLAG, undefined)).toBe(false);
    expect(evaluateBoolean(EARLY_ADOPTER_FLAG, { isEarlyAdopter: 'true' })).toBe(true);
  });

  it('an `enabled: true` flag puts EVERY non-opted-in user in the cohort (the shipped defect)', async () => {
    // The regression case, driven end-to-end. This is the production behaviour measured on
    // Flipt v2.10.0 for oauth-apps / comic-creator / api-key-buzz-limit, and it is what the
    // first version of flipt-state#62 would have done: the segment selects nobody, and the
    // flag is on for the whole internet.
    stubFlipt({ ...EARLY_ADOPTER_FLAG, enabled: true });

    const optedOut = sessionUserFromSettings({}, freshId());
    const features = await getFeatureFlagsAsync({ user: optedOut, req });

    // NOT falsy — a user who never opted in is in the cohort.
    expect(features.earlyAdopter).toBe(true);
  });

  it('an `enabled: true` flag also enrols ANONYMOUS requests', async () => {
    // buildFliptContext omits isEarlyAdopter entirely with no user, so the segment cannot
    // match and the default is all that is left. A cohort gate that fires for logged-out
    // traffic is the worst version of this bug.
    stubFlipt({ ...EARLY_ADOPTER_FLAG, enabled: true });

    const features = await getFeatureFlagsAsync({ user: undefined, req: freshReq() });
    expect(features.earlyAdopter).toBe(true);
  });

  it('app-side `availability: []` does NOT rescue an inverted flag', async () => {
    // The tempting mental model — "availability is [] so we fail closed" — is false
    // whenever Flipt ANSWERS. hasFeature returns the Flipt result and never reaches static
    // evaluation; availability only applies when Flipt is unreachable (returns null).
    stubFlipt({ ...EARLY_ADOPTER_FLAG, enabled: true });

    const optedOut = sessionUserFromSettings({}, freshId());
    expect((await getFeatureFlagsAsync({ user: optedOut, req })).earlyAdopter).toBe(true);

    // Same user, Flipt unreachable → NOW availability: [] fails closed.
    mockIsFliptSync.mockImplementation(() => null);
    const offline = sessionUserFromSettings({}, freshId());
    expect((await getFeatureFlagsAsync({ user: offline, req })).earlyAdopter).toBeFalsy();
  });
});

describe('early-adopter seam: the FeatureAccess memo key must include the opt-in', () => {
  it('flipping the opt-in for the SAME user flips the flag inside the memo TTL', async () => {
    // `getFeatureFlags` memoizes the whole FeatureAccess for 10s under a key built from
    // user identity + host + region (`featureAccessKey`). Refreshing the session is not
    // enough on its own: if that key omits `isEarlyAdopter`, the freshly-refreshed session
    // lands on the entry cached from BEFORE the toggle and the user keeps the old cohort
    // decision for the rest of the TTL — the exact "toggle appears to do nothing" symptom
    // the refresh exists to prevent, reintroduced one layer further down.
    //
    // Same id, same host, same region, same tier, same permissions — so ONLY the opt-in
    // differs. Both calls happen well inside the 10s TTL, which is the point.
    const id = freshId();

    const before = await getFeatureFlagsAsync({
      user: sessionUserFromSettings({ isEarlyAdopter: false }, id),
      req,
    });
    expect(before.earlyAdopter).toBeFalsy();

    const after = await getFeatureFlagsAsync({
      user: sessionUserFromSettings({ isEarlyAdopter: true }, id),
      req,
    });
    expect(after.earlyAdopter).toBe(true);
  });

  it('and back off again, so the key is not just "sticky once true"', async () => {
    const id = freshId();

    expect(
      (
        await getFeatureFlagsAsync({
          user: sessionUserFromSettings({ isEarlyAdopter: true }, id),
          req,
        })
      ).earlyAdopter
    ).toBe(true);
    expect(
      (
        await getFeatureFlagsAsync({
          user: sessionUserFromSettings({ isEarlyAdopter: false }, id),
          req,
        })
      ).earlyAdopter
    ).toBeFalsy();
  });
});
