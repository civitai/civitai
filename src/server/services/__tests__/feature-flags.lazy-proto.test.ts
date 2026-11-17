import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import type { NextApiRequest } from 'next';
import type * as FliptContextModule from '@civitai/flipt/context';
import type { SessionUser } from '~/types/session';

/**
 * `getFeatureFlagsLazy` has two implementations behind the `feature-flags-lazy-proto` switch:
 * the legacy object (one getter closure defined per key on every call) and `LazyFeatureAccess`
 * (getters defined once on a shared prototype, state in per-instance private fields). Every
 * contract test below runs over BOTH, from one table, so the two cannot drift apart; then the
 * switch itself is tested.
 */

const { fliptEvals, switchState, sharedBuildContext } = vi.hoisted(() => ({
  fliptEvals: [] as { flag: string; entityId: string; context: Record<string, string> }[],
  switchState: { value: null as boolean | null },
  sharedBuildContext: { calls: 0 },
}));

const SWITCH_KEY = 'feature-flags-lazy-proto';

// Deterministic, pure stand-in for the Flipt eval: same (flag, entity, context) => same answer,
// mixing true / false / null (static fallback) across keys and users. The switch key answers
// whatever the test sets and is NOT recorded, so it never pollutes the per-key counts.
function fakeIsFliptSync(
  flag: string,
  entityId = 'global',
  context: Record<string, string> = {}
): boolean | null {
  if (flag === SWITCH_KEY) return switchState.value;
  fliptEvals.push({ flag, entityId, context });
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
  FLIPT_FEATURE_FLAGS: { FEATURE_FLAGS_LAZY_PROTO: 'feature-flags-lazy-proto' },
}));

// Count every fliptContext build (the service's `buildFliptContext` delegates here).
vi.mock('@civitai/flipt/context', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptContextModule>();
  return {
    ...actual,
    buildFliptContext: (...a: Parameters<typeof actual.buildFliptContext>) => {
      sharedBuildContext.calls++;
      return actual.buildFliptContext(...a);
    },
  };
});

import {
  featureFlagKeys,
  getFeatureFlags,
  getFeatureFlagsAsync,
  getFeatureFlagsLazy,
  getFeatureFlagsLazyLegacy,
  getFeatureFlagsLazyProto,
  getFeatureFliptKey,
  resetFeatureFlagsLazyGateForTests,
  type FeatureAccess,
  type FeatureAccessContext,
  type FeatureFlagKey,
} from '../feature-flags.service';

function makeReq(): NextApiRequest {
  return { headers: { host: 'civitai.com', 'cf-ipcountry': 'US' } } as unknown as NextApiRequest;
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

// Pairwise-distinct by construction (different ids and roles), and asserted distinct below so a
// fixture change that collapses two of them fails loudly instead of weakening every test.
const fixtures: { name: string; ctx: FeatureAccessContext & { req: IncomingMessage } }[] = [
  { name: 'anon', ctx: { req: makeReq() } },
  { name: 'user', ctx: { user: makeUser({ id: 101 }), req: makeReq() } },
  { name: 'moderator', ctx: { user: makeUser({ id: 102, isModerator: true }), req: makeReq() } },
  {
    name: 'granted permission',
    ctx: { user: makeUser({ id: 103, permissions: ['moderateTags'] }), req: makeReq() },
  },
  { name: 'gold tier', ctx: { user: makeUser({ id: 104, tier: 'gold' }), req: makeReq() } },
];

const impls: { name: string; build: (ctx: FeatureAccessContext) => FeatureAccess }[] = [
  { name: 'legacy', build: getFeatureFlagsLazyLegacy },
  { name: 'proto', build: getFeatureFlagsLazyProto },
];

const read = (obj: FeatureAccess, key: FeatureFlagKey) => obj[key];

beforeAll(async () => {
  // Load the (mocked) Flipt module into the service so the synchronous Flipt branch is live.
  await getFeatureFlagsAsync({ req: makeReq() });
});

beforeEach(() => {
  fliptEvals.length = 0;
  sharedBuildContext.calls = 0;
});

describe('fixtures', () => {
  it('resolve to pairwise-distinct flag sets', () => {
    const sets = fixtures.map(({ ctx }) => {
      const eager = getFeatureFlags(ctx);
      return featureFlagKeys.filter((k) => eager[k] === true).join(',');
    });
    expect(new Set(sets).size).toBe(fixtures.length);
  });
});

describe.each(impls)('$name lazy object', ({ build }) => {
  it.each(fixtures)('$name: every key reads exactly getFeatureFlags(ctx)[key]', ({ ctx }) => {
    const eager = getFeatureFlags(ctx);
    const lazy = build(ctx);
    let present = 0;
    for (const key of featureFlagKeys) {
      const value = read(lazy, key);
      expect([true, undefined], `"${key}" read ${String(value)}`).toContain(value);
      expect(value, `"${key}" diverged`).toBe(eager[key]);
      if (value === true) present++;
    }
    // Non-vacuous: a mix of present and absent keys.
    expect(present).toBeGreaterThan(0);
    expect(present).toBeLessThan(featureFlagKeys.length);
  });

  it('`key in obj` is true for every flag key, and false for a non-flag key', () => {
    const lazy = build(fixtures[1].ctx);
    for (const key of featureFlagKeys) expect(key in lazy, key).toBe(true);
    expect('notAFeatureFlag' in lazy).toBe(false);
  });

  it('is empty to Object.keys, for...in, spread, Object.assign and JSON.stringify', () => {
    const lazy = build(fixtures[2].ctx);
    // Read some keys first: a memo or context must not become visible either.
    for (const key of featureFlagKeys.slice(0, 10)) void read(lazy, key);
    expect(Object.keys(lazy)).toEqual([]);
    const forIn: string[] = [];
    for (const k in lazy) forIn.push(k);
    expect(forIn).toEqual([]);
    expect({ ...lazy }).toEqual({});
    expect(Object.assign({}, lazy)).toEqual({});
    expect(JSON.stringify(lazy)).toBe('{}');
  });

  it('memoises each key: two reads, one Flipt evaluation', () => {
    const ctx = fixtures[0].ctx;
    // A key whose read reaches Flipt for this context (no region/host short-circuit).
    const key = featureFlagKeys.find((k) => {
      if (!getFeatureFliptKey(k)) return false;
      fliptEvals.length = 0;
      void read(build(ctx), k);
      return fliptEvals.length === 1;
    });
    expect(key, 'no flag key reaches Flipt for this fixture').toBeDefined();
    const lazy = build(ctx);
    fliptEvals.length = 0;
    const first = read(lazy, key!);
    const second = read(lazy, key!);
    expect(second).toBe(first);
    expect(fliptEvals.map((e) => e.flag)).toEqual([getFeatureFliptKey(key!)]);
  });

  it('builds the Flipt context once per object, on first access, across different keys', () => {
    const lazy = build(fixtures[1].ctx);
    expect(sharedBuildContext.calls).toBe(0);
    for (const key of featureFlagKeys.slice(0, 20)) void read(lazy, key);
    expect(sharedBuildContext.calls).toBe(1);
    // A second object builds its own.
    void read(build(fixtures[1].ctx), featureFlagKeys[0]);
    expect(sharedBuildContext.calls).toBe(2);
  });

  it('objects from different contexts share no memo and no Flipt context', () => {
    const anon = fixtures[0].ctx;
    const mod = fixtures[2].ctx;
    const eagerAnon = getFeatureFlags(anon);
    const eagerMod = getFeatureFlags(mod);
    const differing = featureFlagKeys.filter((k) => eagerAnon[k] !== eagerMod[k]);
    expect(differing.length).toBeGreaterThan(0);

    // Read every differing key through A first, so A's memo holds them, then through B.
    const a = build(anon);
    for (const key of differing) void read(a, key);
    const b = build(mod);
    for (const key of differing) expect(read(b, key), key).toBe(eagerMod[key]);
    // ...and A still answers for A.
    for (const key of differing) expect(read(a, key), key).toBe(eagerAnon[key]);

    // B's Flipt evaluations carry B's context, not the one A built first.
    fliptEvals.length = 0;
    const a2 = build(anon);
    for (const key of featureFlagKeys) void read(a2, key);
    const b2 = build(mod);
    fliptEvals.length = 0;
    for (const key of featureFlagKeys) void read(b2, key);
    expect(fliptEvals.length).toBeGreaterThan(0);
    for (const e of fliptEvals) expect(e.context.userId, e.flag).toBe(String(mod.user!.id));
  });
});

describe('proto lazy object', () => {
  it('a getter read through a non-instance (prototype-preserving clone) reads undefined', () => {
    const lazy = getFeatureFlagsLazyProto(fixtures[2].ctx);
    const clone = Object.create(Object.getPrototypeOf(lazy)) as FeatureAccess;
    for (const key of featureFlagKeys) expect(read(clone, key), key).toBeUndefined();
  });
});

describe('feature-flags-lazy-proto switch', () => {
  const isProto = (obj: FeatureAccess) => Object.getPrototypeOf(obj) !== Object.prototype;

  afterEach(() => {
    vi.restoreAllMocks();
    switchState.value = null;
    resetFeatureFlagsLazyGateForTests();
  });

  it.each([
    { value: true, proto: true },
    { value: false, proto: false },
    { value: null, proto: false },
  ])('Flipt answering $value selects the proto implementation: $proto', ({ value, proto }) => {
    switchState.value = value;
    resetFeatureFlagsLazyGateForTests();
    const obj = getFeatureFlagsLazy(fixtures[1].ctx);
    expect(isProto(obj)).toBe(proto);
    // Either way it is the same contract.
    const eager = getFeatureFlags(fixtures[1].ctx);
    for (const key of featureFlagKeys) expect(obj[key], key).toBe(eager[key]);
  });

  it('reads the switch at most once per window, and again after it', () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    switchState.value = true;
    resetFeatureFlagsLazyGateForTests();
    expect(isProto(getFeatureFlagsLazy(fixtures[0].ctx))).toBe(true);
    switchState.value = false;
    now += 4_999;
    expect(isProto(getFeatureFlagsLazy(fixtures[0].ctx))).toBe(true);
    now += 1;
    expect(isProto(getFeatureFlagsLazy(fixtures[0].ctx))).toBe(false);
  });
});
