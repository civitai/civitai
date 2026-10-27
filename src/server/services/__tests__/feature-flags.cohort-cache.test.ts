import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';

/**
 * `feature-flags-cohort-cache`: with the flag ON, `getFeatureFlags` takes the Flipt-free flags from a
 * cache keyed by the static inputs they read (no user id) and evaluates only the Flipt-read flags
 * per user. The output must be identical to the flag-OFF computation, key for key and in key order.
 *
 * The ON half of the matrix runs inside ONE cohort TTL window, so contexts that a too-narrow cohort
 * key would merge really do share an entry here — an incomplete key shows up as an ON/OFF diff, not
 * only in the hit/miss counters.
 */

vi.hoisted(() => {
  // Read at import time by the service (color host sets) and region-blocking (restriction config).
  process.env.SERVER_DOMAIN_GREEN = 'green.test';
  process.env.SERVER_DOMAIN_BLUE = 'blue.test';
  process.env.SERVER_DOMAIN_RED = 'red.test';
  // FR restricted since 2020 → isRegionRestricted(FR) === true; US is not restricted.
  process.env.REGION_RESTRICTION_CONFIG = 'FR:2020-01-01';
});

const COHORT_FLAG = 'feature-flags-cohort-cache';

const { state } = vi.hoisted(() => ({
  state: { cohortOn: false, calls: [] as { flag: string; entityId: string }[] },
}));

// Deterministic stand-in for the wasm eval: same (flag, entity, context) ⇒ same answer, mixing
// true / false / null so all three branches of the Flipt block in `hasFeature` run. The answer
// depends on the entity (user id) and the context, as a real percentage/segment rollout does.
function fakeIsFliptSync(
  flag: string,
  entityId = 'global',
  context: Record<string, string> = {}
): boolean | null {
  state.calls.push({ flag, entityId });
  if (flag === COHORT_FLAG) return state.cohortOn;
  const sig = `${flag}|${entityId}|${Object.keys(context)
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
}));

import {
  featureFlagKeys,
  getFeatureFlags,
  getFeatureFlagsAsync,
  getFeatureFlagsCohortCacheStats,
  getFeatureFliptKey,
} from '../feature-flags.service';

type Ctx = { user?: SessionUser; req: NextApiRequest | IncomingMessage };

// Longer than both caches' 10 s TTL.
const PAST_TTL_MS = 11_000;
let now = Date.UTC(2026, 5, 1);
function pastTtl() {
  now += PAST_TTL_MS;
  vi.setSystemTime(now);
}

function makeReq(host: string, country?: string, regionCode?: string): NextApiRequest {
  const headers: Record<string, string> = { host };
  if (country) headers['cf-ipcountry'] = country;
  if (regionCode) headers['cf-region-code'] = regionCode;
  return { headers } as unknown as NextApiRequest;
}

function makeUser(id: number, over: Partial<SessionUser> = {}): SessionUser {
  return {
    id,
    username: `user${id}`,
    isModerator: false,
    tier: 'free',
    permissions: [],
    onboarding: 0,
    ...over,
  } as SessionUser;
}

// Granted flags without a Flipt key, so the permission list reaches the cohort portion.
const GRANTED_PERMS = ['adminTags', 'moderateTags', 'announcements'];

// Pairwise-distinct user ids; neighbours differ in ONE static input where possible, so a cohort key
// missing that input would merge them inside the ON window.
const contexts: { name: string; ctx: Ctx }[] = [
  { name: 'anon / green / US', ctx: { req: makeReq('green.test', 'US') } },
  { name: 'anon / green / FR (restricted)', ctx: { req: makeReq('green.test', 'FR') } },
  { name: 'anon / blue / US', ctx: { req: makeReq('blue.test', 'US') } },
  // The only Flipt-free region-gated flag (`canViewNsfw`, `nonRestricted`) is also host-gated to
  // blue/red, so the region pairs that can tell a region-blind cohort key apart are on red.
  { name: 'anon / red / US', ctx: { req: makeReq('red.test', 'US') } },
  { name: 'anon / red / FR (restricted)', ctx: { req: makeReq('red.test', 'FR') } },
  { name: 'anon / unknown host / no region', ctx: { req: makeReq('other.test') } },
  { name: 'free 101 / green / US', ctx: { user: makeUser(101), req: makeReq('green.test', 'US') } },
  {
    name: 'free 102 / green / US (same cohort as 101, early adopter, app builder)',
    ctx: {
      user: makeUser(102, { isEarlyAdopter: true, appBuilderApproved: true }),
      req: makeReq('green.test', 'US'),
    },
  },
  {
    name: 'free 103 / green / FR (restricted)',
    ctx: { user: makeUser(103), req: makeReq('green.test', 'FR') },
  },
  {
    name: 'free 104 / green / US:CA',
    ctx: { user: makeUser(104), req: makeReq('green.test', 'US', 'CA') },
  },
  { name: 'free 105 / blue / US', ctx: { user: makeUser(105), req: makeReq('blue.test', 'US') } },
  {
    name: 'founder 106 / green / US',
    ctx: { user: makeUser(106, { tier: 'founder' }), req: makeReq('green.test', 'US') },
  },
  {
    name: 'bronze 107 / green / US',
    ctx: { user: makeUser(107, { tier: 'bronze' }), req: makeReq('green.test', 'US') },
  },
  {
    name: 'gold 108 / green / US',
    ctx: { user: makeUser(108, { tier: 'gold' }), req: makeReq('green.test', 'US') },
  },
  {
    name: 'silver 109 / red / FR (restricted)',
    ctx: { user: makeUser(109, { tier: 'silver' }), req: makeReq('red.test', 'FR') },
  },
  {
    name: 'moderator 110 / green / US',
    ctx: { user: makeUser(110, { isModerator: true }), req: makeReq('green.test', 'US') },
  },
  {
    name: 'moderator 111 / green / FR (restricted)',
    ctx: { user: makeUser(111, { isModerator: true }), req: makeReq('green.test', 'FR') },
  },
  {
    name: 'free 112 with permissions / green / US',
    ctx: { user: makeUser(112, { permissions: GRANTED_PERMS }), req: makeReq('green.test', 'US') },
  },
  {
    name: 'free 113 with permissions / green / FR (restricted)',
    ctx: { user: makeUser(113, { permissions: GRANTED_PERMS }), req: makeReq('green.test', 'FR') },
  },
  { name: 'free 115 / red / US', ctx: { user: makeUser(115), req: makeReq('red.test', 'US') } },
  {
    name: 'free 114 early adopter / red / FR (restricted)',
    ctx: {
      user: makeUser(114, { isEarlyAdopter: true }),
      req: makeReq('red.test', 'FR'),
    },
  },
];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  // Load the (mocked) Flipt module so `hasFeature`'s synchronous Flipt branch and the cohort
  // flag read are both live.
  await getFeatureFlagsAsync({ req: makeReq('warmup.test', 'US') });
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  state.cohortOn = false;
  state.calls.length = 0;
  pastTtl();
});

describe('feature-flags-cohort-cache ON === OFF', () => {
  it('produces the same FeatureAccess, key for key and in key order, for every context', () => {
    const off: Record<string, Record<string, boolean>> = {};
    const statsBeforeOff = getFeatureFlagsCohortCacheStats();
    for (const { name, ctx } of contexts) {
      pastTtl(); // each OFF value computed fresh
      off[name] = getFeatureFlags(ctx);
    }
    // OFF never touches the cohort cache.
    expect(getFeatureFlagsCohortCacheStats()).toEqual(statsBeforeOff);

    pastTtl();
    state.cohortOn = true;
    const statsBeforeOn = getFeatureFlagsCohortCacheStats();
    // All ON values inside ONE TTL window: cohort entries are shared wherever the key allows.
    const on: Record<string, Record<string, boolean>> = {};
    for (const { name, ctx } of contexts) on[name] = getFeatureFlags(ctx);
    const statsAfterOn = getFeatureFlagsCohortCacheStats();

    for (const { name } of contexts) {
      expect(on[name], `ON diverged from OFF in "${name}"`).toEqual(off[name]);
      expect(JSON.stringify(on[name]), `key order diverged in "${name}"`).toBe(
        JSON.stringify(off[name])
      );
    }

    // Positive controls: the ON path really ran, and really shared (101 and 102 are one cohort).
    expect(statsAfterOn.misses - statsBeforeOn.misses).toBe(contexts.length - 1);
    expect(statsAfterOn.hits - statsBeforeOn.hits).toBe(1);
  });

  it('is non-vacuous: the Flipt-free flags differ across the matrix and both portions are present', () => {
    const staticKeys = featureFlagKeys.filter((k) => !getFeatureFliptKey(k));
    const fliptKeys = featureFlagKeys.filter((k) => getFeatureFliptKey(k));
    expect(staticKeys.length).toBeGreaterThan(0);
    expect(fliptKeys.length).toBeGreaterThan(0);

    const results = contexts.map(({ ctx }) => {
      pastTtl();
      return getFeatureFlags(ctx) as Record<string, boolean | undefined>;
    });
    // Every static input the matrix varies changes some Flipt-free flag somewhere.
    const staticSignatures = new Set(
      results.map((r) => staticKeys.map((k) => (r[k] ? 1 : 0)).join(''))
    );
    expect(staticSignatures.size).toBeGreaterThan(5);
    expect(results.some((r) => fliptKeys.some((k) => r[k]))).toBe(true);
  });
});

describe('cohort cache sharing', () => {
  it('computes the Flipt-free portion ONCE for two different users in the same cohort', () => {
    state.cohortOn = true;
    const before = getFeatureFlagsCohortCacheStats();
    getFeatureFlags({ user: makeUser(201), req: makeReq('share.test', 'US') });
    getFeatureFlags({
      user: makeUser(202, { isEarlyAdopter: true }),
      req: makeReq('share.test', 'US'),
    });
    const after = getFeatureFlagsCohortCacheStats();
    expect(after.misses - before.misses).toBe(1);
    expect(after.hits - before.hits).toBe(1);
    // Flipt-read flags were still evaluated per user.
    const entities = new Set(
      state.calls.filter((c) => c.flag !== COHORT_FLAG).map((c) => c.entityId)
    );
    expect(entities).toEqual(new Set(['201', '202']));
  });

  const pairs: { input: string; a: Ctx; b: Ctx }[] = [
    {
      input: 'region',
      a: { user: makeUser(301), req: makeReq('split.test', 'US') },
      b: { user: makeUser(302), req: makeReq('split.test', 'FR') },
    },
    {
      input: 'region code',
      a: { user: makeUser(303), req: makeReq('split.test', 'US', 'CA') },
      b: { user: makeUser(304), req: makeReq('split.test', 'US', 'NY') },
    },
    {
      input: 'host',
      a: { user: makeUser(305), req: makeReq('green.test', 'DE') },
      b: { user: makeUser(306), req: makeReq('blue.test', 'DE') },
    },
    {
      input: 'moderator',
      a: { user: makeUser(307), req: makeReq('split.test', 'DE') },
      b: { user: makeUser(308, { isModerator: true }), req: makeReq('split.test', 'DE') },
    },
    {
      input: 'tier',
      a: { user: makeUser(309, { tier: 'bronze' }), req: makeReq('split.test', 'DE') },
      b: { user: makeUser(310, { tier: 'gold' }), req: makeReq('split.test', 'DE') },
    },
    {
      input: 'permissions',
      a: { user: makeUser(311), req: makeReq('split.test', 'JP') },
      b: { user: makeUser(312, { permissions: ['adminTags'] }), req: makeReq('split.test', 'JP') },
    },
    {
      input: 'signed in',
      a: { req: makeReq('anon-split.test', 'JP') },
      b: { user: makeUser(313), req: makeReq('anon-split.test', 'JP') },
    },
  ];
  for (const { input, a, b } of pairs) {
    it(`does NOT share an entry between contexts that differ only in ${input}`, () => {
      state.cohortOn = true;
      const before = getFeatureFlagsCohortCacheStats();
      getFeatureFlags(a);
      getFeatureFlags(b);
      const after = getFeatureFlagsCohortCacheStats();
      expect(after.misses - before.misses).toBe(2);
      expect(after.hits - before.hits).toBe(0);
    });
  }

  it('a restricted and a non-restricted region resolve the region-gated flag differently', () => {
    state.cohortOn = true;
    const us = getFeatureFlags({ user: makeUser(401), req: makeReq('red.test', 'US') });
    const fr = getFeatureFlags({ user: makeUser(402), req: makeReq('red.test', 'FR') });
    expect(us.canViewNsfw).toBe(true);
    expect(fr.canViewNsfw).toBeUndefined();
  });
});
