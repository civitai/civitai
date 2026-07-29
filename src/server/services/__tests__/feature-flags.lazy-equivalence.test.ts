import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';

/**
 * Per-flag lazy feature-flag evaluation — equivalence gate.
 *
 * `getFeatureFlagsLazy` now evaluates ONLY the accessed key (via the shared
 * `isFeatureFlagKeyPresent`) instead of forcing a full `computeFeatureFlags` on
 * first touch. The whole safety story is: for EVERY flag key across every
 * representative context, `lazy.X === getFeatureFlags(ctx).X`. Data-driven over
 * `featureFlagKeys` so a newly-added flag is auto-covered.
 *
 * Plus: reading the Flipt-free `canViewNsfw` triggers ZERO wasm evals; reading
 * one fliptKey'd flag triggers exactly one — the pathology the PR fixes
 * (`applyDomainFeature` reading `canViewNsfw` used to force up to 64 evals).
 */

// These are read at IMPORT time by the service (color-host sets) and by
// region-blocking (restricted-region config) — set them before those modules
// evaluate so the host/region gating branches are actually exercised.
vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
  // FR restricted with a past effective date → isRegionRestricted('FR') === true.
  process.env.REGION_RESTRICTION_CONFIG = 'FR:2020-01-01';
});

const { fliptEvalCalls } = vi.hoisted(() => ({
  fliptEvalCalls: [] as { flag: string; entityId: string }[],
}));

// Deterministic, PURE stand-in for the wasm Flipt eval: same (flag, entityId,
// context) => same result, so eager (all keys) and lazy (one key) — which pass
// identical args per key — cannot diverge. Mixes true / false / null so all
// three branches of the flipt block in `hasFeature` are exercised across keys.
function fakeIsFliptSync(
  flag: string,
  entityId = 'global',
  context: Record<string, string> = {}
): boolean | null {
  fliptEvalCalls.push({ flag, entityId });
  const sig = `${flag}|${entityId}|${Object.keys(context)
    .sort()
    .map((k) => `${k}=${context[k]}`)
    .join('&')}`;
  let h = 0;
  for (let i = 0; i < sig.length; i++) h = (h * 31 + sig.charCodeAt(i)) & 0x7fffffff;
  const m = h % 3;
  if (m === 0) return null; // fall through to static evaluation
  return m === 1; // true or false
}

vi.mock('~/server/flipt/client', () => ({
  isFliptSync: (...a: Parameters<typeof fakeIsFliptSync>) => fakeIsFliptSync(...a),
  ensureFliptInitialized: async () => {},
}));

import {
  featureFlagKeys,
  getFeatureFlags,
  getFeatureFlagsLazy,
  getFeatureFlagsAsync,
  type FeatureFlagKey,
} from '../feature-flags.service';

type Ctx = { user?: SessionUser; req: NextApiRequest | IncomingMessage };

function makeReq(host?: string, country?: string): NextApiRequest {
  const headers: Record<string, string> = {};
  if (host) headers.host = host;
  if (country) headers['cf-ipcountry'] = country;
  return { headers } as unknown as NextApiRequest;
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

// A "granted-everything" user exercises every `granted` availability + permission
// branch (permissions must contain the flag key for a granted flag to pass).
const grantedAll = makeUser({ id: 999, permissions: [...featureFlagKeys] as string[] });

const contexts: { name: string; ctx: Ctx }[] = [
  { name: 'anon / green / US', ctx: { req: makeReq('civitai.com', 'US') } },
  { name: 'anon / red / FR(restricted)', ctx: { req: makeReq('civitai.red', 'FR') } },
  { name: 'anon / unknown-host / no-region', ctx: { req: makeReq('example.org') } },
  { name: 'user free / green / US', ctx: { user: makeUser(), req: makeReq('civitai.com', 'US') } },
  {
    name: 'user founder / green / US',
    ctx: { user: makeUser({ tier: 'founder' }), req: makeReq('civitai.com', 'US') },
  },
  {
    name: 'user bronze / blue / US',
    ctx: { user: makeUser({ tier: 'bronze' }), req: makeReq('civitai.blue', 'US') },
  },
  {
    name: 'user silver / red / FR(restricted)',
    ctx: { user: makeUser({ tier: 'silver' }), req: makeReq('civitai.red', 'FR') },
  },
  {
    name: 'user gold / green / US',
    ctx: { user: makeUser({ tier: 'gold' }), req: makeReq('civitai.com', 'US') },
  },
  {
    name: 'user free / red / FR(restricted)',
    ctx: { user: makeUser(), req: makeReq('civitai.red', 'FR') },
  },
  {
    name: 'user gold / unknown-host / no-region',
    ctx: { user: makeUser({ tier: 'gold' }), req: makeReq('example.org') },
  },
  {
    name: 'moderator / green / US',
    ctx: { user: makeUser({ id: 7, isModerator: true }), req: makeReq('civitai.com', 'US') },
  },
  {
    name: 'moderator / red / FR(restricted)',
    ctx: { user: makeUser({ id: 7, isModerator: true }), req: makeReq('civitai.red', 'FR') },
  },
  { name: 'granted-all / green / US', ctx: { user: grantedAll, req: makeReq('civitai.com', 'US') } },
  {
    name: 'granted-all / red / FR(restricted)',
    ctx: { user: grantedAll, req: makeReq('civitai.red', 'FR') },
  },
];

beforeAll(async () => {
  // Prime the private `_fliptModule` (our mock) so the SYNCHRONOUS `isFliptSync`
  // path inside `hasFeature` is live for both eager and lazy — otherwise the
  // flipt branch is skipped entirely and the flipt gating is never exercised.
  await getFeatureFlagsAsync({ req: makeReq('civitai.com', 'US') });
});

describe('lazy per-flag === eager, for every flag key across representative contexts', () => {
  for (const { name, ctx } of contexts) {
    it(name, () => {
      const eager = getFeatureFlags(ctx);
      const lazy = getFeatureFlagsLazy(ctx);
      for (const key of featureFlagKeys) {
        expect(
          lazy[key as keyof typeof lazy],
          `flag "${key}" diverged in context "${name}"`
        ).toBe(eager[key as keyof typeof eager]);
      }
    });
  }

  it('covers every registered flag key (data-driven, so new flags auto-covered)', () => {
    expect(featureFlagKeys.length).toBeGreaterThan(60);
  });

  it('is non-vacuous: a representative context yields BOTH present and absent flags', () => {
    // Guards against a false "equivalence" where eager and lazy are identically
    // broken (e.g. everything undefined). granted-all/green/US resolves a real
    // mix of present (true) and absent (undefined) keys.
    const eager = getFeatureFlags({ user: grantedAll, req: makeReq('civitai.com', 'US') });
    const present = featureFlagKeys.filter((k) => eager[k as keyof typeof eager] === true).length;
    const absent = featureFlagKeys.length - present;
    expect(present).toBeGreaterThan(0);
    expect(absent).toBeGreaterThan(0);
  });
});

describe('lazy evaluates ONLY the accessed key', () => {
  it('reading canViewNsfw (no fliptKey) triggers ZERO Flipt evals; a fliptKey flag triggers exactly one', () => {
    const ctx: Ctx = { req: makeReq('civitai.com', 'US') };
    const lazy = getFeatureFlagsLazy(ctx);

    // canViewNsfw has NO fliptKey → the flipt branch must never run.
    fliptEvalCalls.length = 0;
    void lazy.canViewNsfw;
    expect(fliptEvalCalls).toHaveLength(0);

    // videoTraining (fliptKey 'video-training', public availability) reaches the
    // flipt eval → exactly ONE call for that single key (not all 64).
    fliptEvalCalls.length = 0;
    void lazy.videoTraining;
    expect(fliptEvalCalls).toHaveLength(1);
    expect(fliptEvalCalls[0].flag).toBe('video-training');

    // Memoized: a repeat read of the same key does not re-eval.
    fliptEvalCalls.length = 0;
    void lazy.videoTraining;
    expect(fliptEvalCalls).toHaveLength(0);
  });

  it('eager compute evaluates MANY flags (the work lazy avoids)', () => {
    // Unique user id → a fresh result-cache key so this genuinely recomputes
    // (a previously-computed context would be served from the 10s result cache
    // and eval zero flags).
    const ctx: Ctx = { user: makeUser({ id: 555555 }), req: makeReq('civitai.com', 'US') };
    fliptEvalCalls.length = 0;
    getFeatureFlags(ctx);
    // The full compute walks every fliptKey'd flag that passes gating — far more
    // than the single eval the lazy path pays when only canViewNsfw is read.
    expect(fliptEvalCalls.length).toBeGreaterThan(20);
  });
});
