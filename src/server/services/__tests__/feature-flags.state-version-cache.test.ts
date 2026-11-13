import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';

/**
 * `getFeatureFlags` behind `feature-flags-state-version-cache`: whole-registry results kept until
 * the Flipt state version moves (or 10 minutes), instead of 10 seconds. These pin:
 *   - the same answer per key as the 10-second cache, for every fixture (user-targeted and
 *     anonymous), so the switch changes cost and nothing else;
 *   - the point of it: a repeat read 60s later costs no Flipt evaluation;
 *   - a version move drops every entry at once (a Flipt change is not held for the long TTL);
 *   - an entry computed while the eval cache may still hold pre-move answers keeps the 10s TTL;
 *   - every input of the evaluation is in the key (a Flipt-context-only difference, a
 *     permissions-only difference, a host-only difference, a region-only difference, and a
 *     region restriction taking effect while an entry is still live).
 */

// Read at IMPORT time by the service (color-host sets) and by region-blocking (restriction
// config), so set them before those modules evaluate; otherwise the host and region branches of
// `hasFeature` never run and the key tests below have nothing to tell apart.
vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
  // FR: restricted since long ago. DE: restricted from the end of 2030-01-01 (UTC), so a test can
  // step the clock across the moment it takes effect.
  process.env.REGION_RESTRICTION_CONFIG = 'FR:2020-01-01,DE:2030-01-01';
});

const { fliptEvals, flipt } = vi.hoisted(() => ({
  fliptEvals: [] as { flag: string; entityId: string; context: Record<string, string> }[],
  flipt: {
    switchOn: null as boolean | null,
    version: 1,
    // What the fake engine answers depends on this too, so a test can change "the flag state".
    epoch: 0,
    evalCacheTtlMs: 10_000,
  },
}));

const SWITCH_KEY = 'feature-flags-state-version-cache';

// Deterministic stand-in for the Flipt eval: same (flag, entity, context, epoch) => same answer,
// mixing true / false / null (static fallback). The switch key answers whatever the test sets and
// is NOT recorded.
function fakeIsFliptSync(
  flag: string,
  entityId = 'global',
  context: Record<string, string> = {}
): boolean | null {
  if (flag === SWITCH_KEY) return flipt.switchOn;
  fliptEvals.push({ flag, entityId, context });
  const sig = `${flipt.epoch}|${flag}|${entityId}|${Object.keys(context)
    .sort()
    .map((k) => `${k}=${context[k]}`)
    .join('&')}`;
  let h = 0;
  for (let i = 0; i < sig.length; i++) h = (h * 31 + sig.charCodeAt(i)) & 0x7fffffff;
  const m = h % 3;
  if (m === 0) return null;
  return m === 1;
}

vi.mock('~/server/flipt/client', () => ({
  isFliptSync: (...a: Parameters<typeof fakeIsFliptSync>) => fakeIsFliptSync(...a),
  ensureFliptInitialized: async () => undefined,
  getFliptStateVersion: () => flipt.version,
  getFliptEvalCacheTtlMs: () => flipt.evalCacheTtlMs,
  FLIPT_FEATURE_FLAGS: {
    FEATURE_FLAGS_LAZY_PROTO: 'feature-flags-lazy-proto',
    FEATURE_FLAGS_STATE_VERSION_CACHE: 'feature-flags-state-version-cache',
  },
}));

import {
  FEATURE_ACCESS_VERSIONED_TTL_MS,
  featureFlagKeys,
  getFeatureFlags,
  getFeatureFlagsAsync,
  resetFeatureFlagsStateVersionCacheForTests,
  type FeatureAccess,
  type FeatureAccessContext,
} from '../feature-flags.service';
import { OnboardingSteps } from '~/server/common/enums';

function makeReq(host = 'civitai.com', country = 'US'): NextApiRequest {
  return { headers: { host, 'cf-ipcountry': country } } as unknown as NextApiRequest;
}

function makeUser(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 100,
    username: 'u',
    isModerator: false,
    tier: 'free',
    permissions: [],
    onboarding: 0,
    ...over,
  } as SessionUser;
}

const fixtures: { name: string; ctx: FeatureAccessContext }[] = [
  { name: 'anon', ctx: { req: makeReq() } },
  { name: 'user', ctx: { user: makeUser({ id: 101 }), req: makeReq() } },
  { name: 'moderator', ctx: { user: makeUser({ id: 102, isModerator: true }), req: makeReq() } },
  {
    name: 'granted permission',
    ctx: { user: makeUser({ id: 103, permissions: ['moderateTags'] }), req: makeReq() },
  },
  { name: 'gold tier', ctx: { user: makeUser({ id: 104, tier: 'gold' }), req: makeReq() } },
  {
    name: 'creator program',
    ctx: {
      user: makeUser({ id: 105, onboarding: OnboardingSteps.CreatorProgram }),
      req: makeReq(),
    },
  },
];

const present = (features: FeatureAccess) =>
  featureFlagKeys.filter((k) => features[k] === true).join(',');

let now = 1_000_000_000_000;

/** The switch as given, with every cache emptied and the clock at `now`. */
function setSwitch(on: boolean) {
  flipt.switchOn = on;
  resetFeatureFlagsStateVersionCacheForTests();
}

beforeAll(async () => {
  // Load the (mocked) Flipt module into the service so the synchronous Flipt branch is live.
  await getFeatureFlagsAsync({ req: makeReq() });
});

beforeEach(() => {
  now = 1_000_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  fliptEvals.length = 0;
  flipt.version = 1;
  flipt.epoch = 0;
  flipt.evalCacheTtlMs = 10_000;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Read once to let the cache see the current version, then step past the eval-cache window. */
function settle() {
  getFeatureFlags(fixtures[0].ctx);
  now += flipt.evalCacheTtlMs + 1;
}

describe('same answer as the 10-second cache', () => {
  it.each(fixtures)('$name: every key', ({ ctx }) => {
    setSwitch(false);
    const off = present(getFeatureFlags(ctx));
    setSwitch(true);
    settle();
    const on = present(getFeatureFlags(ctx));
    // And from the cache, not just the first compute.
    const cached = present(getFeatureFlags(ctx));
    expect(on).toBe(off);
    expect(cached).toBe(off);
  });

  it('fixtures resolve to pairwise-distinct flag sets (otherwise the table above is weak)', () => {
    setSwitch(false);
    const sets = fixtures.map(({ ctx }) => present(getFeatureFlags(ctx)));
    expect(new Set(sets).size).toBe(fixtures.length);
  });

  it('hands out a copy: mutating a result does not reach the next read', () => {
    setSwitch(true);
    settle();
    const ctx = fixtures[1].ctx;
    const first = getFeatureFlags(ctx);
    const before = present(first);
    for (const key of featureFlagKeys) (first as Record<string, boolean>)[key] = true;
    expect(present(getFeatureFlags(ctx))).toBe(before);
  });
});

describe('cost', () => {
  it('ON: a read 60s later is served without evaluating Flipt', () => {
    setSwitch(true);
    settle();
    const ctx = fixtures[1].ctx;
    getFeatureFlags(ctx);
    expect(fliptEvals.length).toBeGreaterThan(0); // POSITIVE CONTROL: the first read evaluates
    fliptEvals.length = 0;
    now += 60_000;
    getFeatureFlags(ctx);
    expect(fliptEvals.length).toBe(0);
  });

  it('OFF: the same read 60s later evaluates again (the 10s cache, unchanged)', () => {
    setSwitch(false);
    const ctx = fixtures[1].ctx;
    getFeatureFlags(ctx);
    fliptEvals.length = 0;
    now += 60_000;
    getFeatureFlags(ctx);
    expect(fliptEvals.length).toBeGreaterThan(0);
  });

  it('ON: an entry still expires after the long TTL', () => {
    setSwitch(true);
    settle();
    const ctx = fixtures[1].ctx;
    getFeatureFlags(ctx);
    fliptEvals.length = 0;
    now += FEATURE_ACCESS_VERSIONED_TTL_MS + 1;
    getFeatureFlags(ctx);
    expect(fliptEvals.length).toBeGreaterThan(0);
  });
});

describe('a Flipt state change', () => {
  it('reaches the next read as soon as the version moves', () => {
    setSwitch(true);
    settle();
    const ctx = fixtures[1].ctx;
    const before = present(getFeatureFlags(ctx));

    flipt.epoch = 1; // the engine now answers differently...
    flipt.version = 2; // ...and the client says so
    now += 1_000;
    const after = present(getFeatureFlags(ctx));

    // What a fresh compute under the new state gives, through the 10s path.
    setSwitch(false);
    const fresh = present(getFeatureFlags(ctx));
    expect(fresh).not.toBe(before); // POSITIVE CONTROL: the change is visible at all
    expect(after).toBe(fresh);
  });

  it('without a version move, the entry is kept (the version is the only invalidation)', () => {
    setSwitch(true);
    settle();
    const ctx = fixtures[1].ctx;
    const before = present(getFeatureFlags(ctx));
    flipt.epoch = 1;
    now += 60_000;
    expect(present(getFeatureFlags(ctx))).toBe(before);
  });

  it('an entry computed inside the eval-cache window after a move gets the 10s TTL, not the long one', () => {
    setSwitch(true);
    settle();
    const ctx = fixtures[1].ctx;

    // The version moves, but the eval cache still answers with the pre-move state (epoch 0) for
    // up to its TTL. An entry computed now may embed those answers.
    flipt.version = 2;
    now += 1_000;
    const stale = present(getFeatureFlags(ctx));

    // The eval cache's pre-move answers have expired; the engine answers with the new state. No
    // further version move.
    flipt.epoch = 1;
    now += 10_001;
    const later = present(getFeatureFlags(ctx));

    setSwitch(false);
    const fresh = present(getFeatureFlags(ctx));
    expect(fresh).not.toBe(stale); // POSITIVE CONTROL: the two states differ for this user
    expect(later).toBe(fresh);
  });
});

describe('every input is in the key', () => {
  it('two users differing only in the Creator Program bit (Flipt context only) get their own results', () => {
    const a = { user: makeUser({ id: 200 }), req: makeReq() };
    const b = {
      user: makeUser({ id: 200, onboarding: OnboardingSteps.CreatorProgram }),
      req: makeReq(),
    };
    setSwitch(false);
    const expectedB = present(getFeatureFlags(b));
    setSwitch(false);
    const expectedA = present(getFeatureFlags(a));
    expect(expectedA).not.toBe(expectedB); // POSITIVE CONTROL

    setSwitch(true);
    settle();
    getFeatureFlags(a);
    expect(present(getFeatureFlags(b))).toBe(expectedB);
  });

  it('two users differing only in permissions get their own results', () => {
    const a = { user: makeUser({ id: 300 }), req: makeReq() };
    const b = { user: makeUser({ id: 300, permissions: ['moderateTags'] }), req: makeReq() };
    setSwitch(false);
    const expectedB = present(getFeatureFlags(b));
    setSwitch(false);
    const expectedA = present(getFeatureFlags(a));
    expect(expectedA).not.toBe(expectedB); // POSITIVE CONTROL

    setSwitch(true);
    settle();
    getFeatureFlags(a);
    expect(present(getFeatureFlags(b))).toBe(expectedB);
  });

  // `isGreen` is on only on the green host, `isRed` only on blue/red: domain gating.
  it('the same user on two hosts gets each host its own result', () => {
    const user = makeUser({ id: 400 });
    const a = { user, req: makeReq('civitai.com') };
    const b = { user, req: makeReq('civitai.red') };
    setSwitch(false);
    const expectedB = present(getFeatureFlags(b));
    setSwitch(false);
    const expectedA = present(getFeatureFlags(a));
    expect(expectedA).not.toBe(expectedB); // POSITIVE CONTROL

    setSwitch(true);
    settle();
    getFeatureFlags(a);
    expect(present(getFeatureFlags(b))).toBe(expectedB);
  });

  // `canViewNsfw` needs a non-restricted region (and a blue/red host); FR is restricted.
  it('the same user from two regions gets each region its own result', () => {
    const user = makeUser({ id: 500 });
    const a = { user, req: makeReq('civitai.red', 'US') };
    const b = { user, req: makeReq('civitai.red', 'FR') };
    setSwitch(false);
    const expectedB = present(getFeatureFlags(b));
    setSwitch(false);
    const expectedA = present(getFeatureFlags(a));
    expect(expectedA).not.toBe(expectedB); // POSITIVE CONTROL

    setSwitch(true);
    settle();
    getFeatureFlags(a);
    expect(present(getFeatureFlags(b))).toBe(expectedB);
  });

  // Same user, region and host: only the date moves, across DE's restriction taking effect, inside
  // the life of a long-TTL entry. Unless the key's restricted bit changes with it, the entry
  // computed before keeps serving `canViewNsfw` for up to the long TTL.
  it('a region restriction taking effect reaches a still-live entry', () => {
    vi.restoreAllMocks(); // drop the Date.now spy: this test drives the whole Date
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const ctx = { user: makeUser({ id: 600 }), req: makeReq('civitai.red', 'DE') };
      const before = new Date('2030-01-01T23:58:00Z').getTime();
      const after = new Date('2030-01-02T00:00:30Z').getTime();

      vi.setSystemTime(after);
      setSwitch(false);
      const expectedAfter = present(getFeatureFlags(ctx));
      vi.setSystemTime(before);
      setSwitch(false);
      const expectedBefore = present(getFeatureFlags(ctx));
      expect(expectedBefore).not.toBe(expectedAfter); // POSITIVE CONTROL

      setSwitch(true);
      getFeatureFlags(ctx); // the cache sees the version now
      const settledAt = before + flipt.evalCacheTtlMs + 1;
      vi.setSystemTime(settledAt);
      expect(present(getFeatureFlags(ctx))).toBe(expectedBefore); // stored with the long TTL
      // The step below stays inside that entry's life, so only the key can retire it.
      expect(after - settledAt).toBeLessThan(FEATURE_ACCESS_VERSIONED_TTL_MS);

      vi.setSystemTime(after);
      expect(present(getFeatureFlags(ctx))).toBe(expectedAfter);
    } finally {
      vi.useRealTimers();
    }
  });
});
