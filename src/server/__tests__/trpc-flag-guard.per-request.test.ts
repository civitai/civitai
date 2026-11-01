import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import type * as FliptClient from '~/server/flipt/client';
import type { SessionUser } from '~/types/session';

/**
 * `isFlagProtected(flag)` guards a procedure on ONE flag. It used to answer by building the whole
 * registry (`getFeatureFlags(ctx)`), so a request whose (user, host, region) was not in the
 * short-lived whole-result cache paid one Flipt evaluation per Flipt-backed flag in the registry
 * to read a single key. Behind the dark `trpc-flag-guard-per-request` switch it reads the key from
 * `ctx.features` instead: every procedure of a tRPC batch shares one context, so one lazy
 * `getFeatureFlagsLazy` object, which evaluates each key read once. That the lazy and eager paths
 * agree per key is `feature-flags.lazy-equivalence.test.ts`'s job, not this file's.
 *
 * Driven through tRPC's own caller and the real `publicProcedure` chain, so the guard runs exactly
 * as a procedure sees it. Flipt is the only stub: a pure function of (flag, entity, context).
 */

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
  // FR restricted with a past effective date, so the restricted-region branches are reachable.
  process.env.REGION_RESTRICTION_CONFIG = 'FR:2020-01-01';
});

const SWITCH_KEY = 'trpc-flag-guard-per-request';

const flipt = vi.hoisted(() => ({
  calls: [] as { flag: string; entityId: string }[],
  // Per-key answers that win over the hash below; `undefined` = not overridden.
  overrides: {} as Record<string, boolean | null | undefined>,
}));

function hashed(flag: string, entityId: string, context: Record<string, string>): boolean | null {
  const sig = `${flag}|${entityId}|${Object.keys(context)
    .sort()
    .map((k) => `${k}=${context[k]}`)
    .join('&')}`;
  let h = 0;
  for (let i = 0; i < sig.length; i++) h = (h * 31 + sig.charCodeAt(i)) & 0x7fffffff;
  const m = h % 3;
  if (m === 0) return null; // Flipt has no answer: static availability decides
  return m === 1;
}

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: (flag: string, entityId = 'global', context: Record<string, string> = {}) => {
    flipt.calls.push({ flag, entityId });
    const override = flipt.overrides[flag];
    return override !== undefined ? override : hashed(flag, entityId, context);
  },
  ensureFliptInitialized: async () => undefined,
}));

import {
  getFeatureFlagsAsync,
  getFeatureFlagsLazyLegacy,
  getFeatureFlagsLazyProto,
  type FeatureAccess,
  type FeatureAccessContext,
} from '~/server/services/feature-flags.service';
import { isFlagProtected, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

type Caller = Record<string, () => Promise<unknown>>;

const makeReq = (host?: string, country?: string) => {
  const headers: Record<string, string> = {};
  if (host) headers.host = host;
  if (country) headers['cf-ipcountry'] = country;
  return { headers } as unknown as NextApiRequest;
};

// Every case takes a fresh id: `getFeatureFlags` caches its whole result per identity, and the
// switch-off case must not read an answer another case computed.
let nextUserId = 5000;
const makeUser = (over: Partial<SessionUser> = {}) =>
  ({
    id: nextUserId++,
    username: 'u',
    isModerator: false,
    tier: 'free',
    permissions: [],
    onboarding: 0,
    ...over,
  } as SessionUser);

// Both implementations behind `feature-flags-lazy-proto`, chosen explicitly (never through
// `getFeatureFlagsLazy`, whose choice would follow this file's Flipt stub's answer for the switch).
type BuildLazy = (ctx: FeatureAccessContext) => FeatureAccess;
const impls: { name: string; build: BuildLazy }[] = [
  { name: 'legacy', build: getFeatureFlagsLazyLegacy },
  { name: 'proto', build: getFeatureFlagsLazyProto },
];

const ctxFor = (build: BuildLazy, user: SessionUser | undefined, req: NextApiRequest) =>
  ({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    // As `createContext` builds it: one lazy object per request.
    features: build({ user, req }),
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);

const allowed = (call: Promise<unknown>) =>
  call.then(
    () => true,
    (e: { code?: string }) => {
      if (e?.code === 'FORBIDDEN') return false;
      throw e;
    }
  );

// A batch: three procedures behind one flag, two behind another.
const batchRouter = router({
  hubsA: publicProcedure.use(isFlagProtected('userHubs')).query(() => 'ok'),
  hubsB: publicProcedure.use(isFlagProtected('userHubs')).query(() => 'ok'),
  hubsC: publicProcedure.use(isFlagProtected('userHubs')).query(() => 'ok'),
  reviewA: publicProcedure.use(isFlagProtected('collectionAiReview')).query(() => 'ok'),
  reviewB: publicProcedure.use(isFlagProtected('collectionAiReview')).query(() => 'ok'),
});

const batch = (caller: Caller) =>
  Promise.all(['hubsA', 'hubsB', 'hubsC', 'reviewA', 'reviewB'].map((p) => allowed(caller[p]())));

beforeAll(async () => {
  // Primes the service's lazily imported Flipt module with the stub. Without it the Flipt branch
  // is skipped outright and every assertion below runs on static availability alone.
  await getFeatureFlagsAsync({ req: makeReq('prime.example.invalid') });
});

beforeEach(() => {
  flipt.overrides = { [SWITCH_KEY]: true };
  flipt.calls.length = 0;
});

describe.each(impls)('one HTTP request ($name lazy object)', ({ build }) => {
  it('evaluates each guarded flag once for a whole batch, not the registry per procedure', async () => {
    flipt.overrides['user-hubs'] = true;
    flipt.overrides['collection-ai-review'] = null; // static ['mod'] decides: a free user is refused
    const caller = batchRouter.createCaller(
      ctxFor(build, makeUser(), makeReq('civitai.com', 'US'))
    ) as unknown as Caller;

    expect(await batch(caller)).toEqual([true, true, true, false, false]);
    // Three procedures on `userHubs` and two on `collectionAiReview` share one request: one
    // evaluation per distinct flag, plus the switch itself.
    expect(flipt.calls.map((c) => c.flag).sort()).toEqual([
      'collection-ai-review',
      SWITCH_KEY, // 'trpc-flag-guard-per-request' — the list is sorted
      'user-hubs',
    ]);
  });

  it('with the switch off, the guard takes the whole-registry path and answers the same', async () => {
    flipt.overrides[SWITCH_KEY] = null; // dark: no Flipt answer, static `[]` = off
    flipt.overrides['user-hubs'] = true;
    flipt.overrides['collection-ai-review'] = null;
    const caller = batchRouter.createCaller(
      ctxFor(build, makeUser(), makeReq('civitai.com', 'US'))
    ) as unknown as Caller;

    expect(await batch(caller)).toEqual([true, true, true, false, false]);
    // The kill switch really switches: the old path evaluates the registry's Flipt keys.
    expect(flipt.calls.length).toBeGreaterThan(10);
  });
});
