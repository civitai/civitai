import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import type * as FliptClient from '~/server/flipt/client';
import type { SessionUser } from '~/types/session';

/**
 * `isFlagProtected(flag)` guards a procedure on ONE flag. It used to answer by building the whole
 * registry (`getFeatureFlags(ctx)`), so a request whose (user, host, region) was not in the
 * short-lived whole-result cache paid one Flipt evaluation per Flipt-backed flag in the registry
 * to read a single key. Behind the dark `trpc-flag-guard-per-request` switch it now evaluates only
 * the guarded key, once per HTTP request: every procedure of a tRPC batch shares one context, and
 * so one request object.
 *
 * Driven through tRPC's own caller and the real `publicProcedure` chain, so the guard runs exactly
 * as a procedure sees it. Flipt is the only stub: a pure function of (flag, entity, context), so
 * the old whole-registry path and the new per-key path are handed identical answers per key.
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
  featureFlagKeys,
  getFeatureFlags,
  getFeatureFlagsAsync,
  type FeatureFlagKey,
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

// Every case takes a fresh id: `getFeatureFlags` caches its whole result per identity, and a
// case must not read an answer another case computed.
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

const ctxFor = (user: SessionUser | undefined, req: NextApiRequest) =>
  ({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    // `applyDomainFeature` in the base chain reads this; the guard does not.
    features: {},
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

// One procedure per registry key, so the equivalence sweep below covers every flag a guard can name.
const everyFlagRouter = router(
  Object.fromEntries(
    featureFlagKeys.map((key) => [key, publicProcedure.use(isFlagProtected(key)).query(() => 'ok')])
  )
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

describe('guard answer is unchanged, for every flag', () => {
  // INVARIANT guard (green before and after the change): the guard must allow exactly what the
  // pre-change guard allowed, `!!getFeatureFlags(ctx)[flag]`, for every key and principal.
  const grantedAll = () => makeUser({ permissions: [...featureFlagKeys] as string[] });
  const contexts: {
    name: string;
    user: () => SessionUser | undefined;
    req: () => NextApiRequest;
  }[] = [
    { name: 'anon / green / US', user: () => undefined, req: () => makeReq('civitai.com', 'US') },
    { name: 'anon / red / FR', user: () => undefined, req: () => makeReq('civitai.red', 'FR') },
    { name: 'anon / unknown host', user: () => undefined, req: () => makeReq('example.org') },
    {
      name: 'free user / green / US',
      user: () => makeUser(),
      req: () => makeReq('civitai.com', 'US'),
    },
    {
      name: 'gold member / blue / US',
      user: () => makeUser({ tier: 'gold' }),
      req: () => makeReq('civitai.blue', 'US'),
    },
    {
      name: 'moderator / green / US',
      user: () => makeUser({ isModerator: true }),
      req: () => makeReq('civitai.com', 'US'),
    },
    {
      name: 'moderator / red / FR',
      user: () => makeUser({ isModerator: true }),
      req: () => makeReq('civitai.red', 'FR'),
    },
    { name: 'granted-all / green / US', user: grantedAll, req: () => makeReq('civitai.com', 'US') },
  ];

  let allowedTotal = 0;
  let deniedTotal = 0;

  for (const { name, user, req } of contexts) {
    it(name, async () => {
      const u = user();
      const r = req();
      const expected = getFeatureFlags({ user: u, req: r });
      const caller = everyFlagRouter.createCaller(ctxFor(u, r)) as unknown as Caller;
      for (const key of featureFlagKeys as FeatureFlagKey[]) {
        const got = await allowed(caller[key]());
        expect(got, `flag "${key}" in "${name}"`).toBe(expected[key] === true);
        if (got) allowedTotal++;
        else deniedTotal++;
      }
    });
  }

  it('is non-vacuous: the sweep both allowed and refused', () => {
    expect(allowedTotal).toBeGreaterThan(0);
    expect(deniedTotal).toBeGreaterThan(0);
  });
});

describe('one HTTP request', () => {
  it('evaluates each guarded flag once for a whole batch, not the registry per procedure', async () => {
    flipt.overrides['user-hubs'] = true;
    flipt.overrides['collection-ai-review'] = null; // static ['mod'] decides: a free user is refused
    const caller = batchRouter.createCaller(
      ctxFor(makeUser(), makeReq('civitai.com', 'US'))
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
      ctxFor(makeUser(), makeReq('civitai.com', 'US'))
    ) as unknown as Caller;

    expect(await batch(caller)).toEqual([true, true, true, false, false]);
    // The kill switch really switches: the old path evaluates the registry's Flipt keys.
    expect(flipt.calls.length).toBeGreaterThan(10);
  });
});

describe('no answer leaks between users or requests', () => {
  beforeEach(() => {
    flipt.overrides['collection-ai-review'] = null; // static ['mod']
  });

  it('two requests in a row, moderator then anonymous, and the reverse', async () => {
    const mod = makeUser({ isModerator: true });
    const one = (user: SessionUser | undefined) =>
      allowed(
        (
          batchRouter.createCaller(ctxFor(user, makeReq('civitai.com', 'US'))) as unknown as Caller
        ).reviewA()
      );

    expect(await one(mod)).toBe(true);
    expect(await one(undefined)).toBe(false);
    expect(await one(undefined)).toBe(false);
    expect(await one(mod)).toBe(true);
  });

  it('a different user on the same request object gets their own answer', async () => {
    const req = makeReq('civitai.com', 'US');
    const mod = makeUser({ isModerator: true });
    const call = (user: SessionUser | undefined) =>
      allowed((batchRouter.createCaller(ctxFor(user, req)) as unknown as Caller).reviewA());

    expect(await call(mod)).toBe(true);
    expect(await call(undefined)).toBe(false);
    expect(await call(makeUser())).toBe(false);
    expect(await call(mod)).toBe(true);
  });

  it('a Flipt change is seen by the next request, and not midway through the current one', async () => {
    flipt.overrides['user-hubs'] = true;
    const user = makeUser();
    const first = makeReq('civitai.com', 'US');
    const callerFor = (req: NextApiRequest) =>
      batchRouter.createCaller(ctxFor(user, req)) as unknown as Caller;

    expect(await allowed(callerFor(first).hubsA())).toBe(true);
    flipt.overrides['user-hubs'] = false;
    // Same request: one answer per request, so a batch cannot straddle a flip.
    expect(await allowed(callerFor(first).hubsB())).toBe(true);
    // The next request evaluates afresh rather than reading an earlier request's answer.
    expect(await allowed(callerFor(makeReq('civitai.com', 'US')).hubsA())).toBe(false);
  });
});
