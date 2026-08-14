import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';

/**
 * 🔴 THE SERVER/CLIENT SEAM for `app-listings-public-external`.
 *
 * The SAME Flipt flag is evaluated TWICE per request, by two different code paths
 * that have never shared a test:
 *
 *   SERVER DATA PATH   `isExternalListingsPublicEnabled({ user })`
 *                      → `isFlipt(key, id, ctx)`            (ASYNC eval)
 *                      → `resolveStoreVisibilityScope` → the store read procs.
 *
 *   PAGE GATE          `featureFlags.appListingsPublicExternal`
 *                      → `isFliptSync(key, id, ctx)`        (SYNC eval, + a static
 *                        `availability` fallback when Flipt answers `null`)
 *                      → `ctx.features` → `hasAppsStoreAccess` → `resolveAppsPageAccess`.
 *
 * If they disagree the feature is broken in one of two silent ways: the viewer
 * passes the page gate and sees an EMPTY store, or the viewer is 404'd off a
 * catalog the server would happily have served. Neither surfaces as an error.
 *
 * ⚠️ EVERY OTHER SUITE HERE TESTS ONE SIDE IN ISOLATION. `app-blocks-flag.*` mocks
 * Flipt and exercises only the server helpers; `hasAppsStoreAccess.test.ts` feeds
 * the predicate a hand-written features object. Both can be green while the pair is
 * incoherent — the isolated-seam failure mode. So this file loads BOTH REAL sides
 * (the real `feature-flags.service`, the real `app-blocks-flag`, the real shared
 * predicate and the real SSR resolver) against ONE fake Flipt configuration and
 * asserts the RELATIONSHIP:
 *
 *      resolveAppsPageAccess grants  ⟺  resolveStoreVisibilityScope !== 'none'
 *
 * The two asymmetries the fake models faithfully, because they are exactly what a
 * hand-written double would get wrong:
 *   - the ASYNC `isEnabled` returns `false` for an absent flag / eval error, while
 *     the SYNC `isEnabledSync` returns `null` and lets the caller fall through to
 *     the static `availability`. That asymmetry is why the client entry is
 *     `availability: []` and not `['mod']`.
 *   - the anon eval identity differs by construction: `'global'`/`{}` on the server
 *     vs `'anonymous'`/`{isLoggedIn:'false'}` in the client gate. Pinned explicitly
 *     at the bottom rather than papered over.
 */

// Read at IMPORT time by feature-flags.service (color-host sets) — set before the
// module evaluates, mirroring feature-flags.lazy-equivalence.test.ts.
vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});

type FlagShape =
  | { kind: 'absent' }
  | { kind: 'base'; enabled: boolean }
  | { kind: 'segment'; base: boolean; match: (ctx: Record<string, string>) => boolean }
  /** Percentage-style: the decision is a function of the ENTITY ID, not the context. */
  | { kind: 'byEntity'; match: (entityId: string) => boolean };

const { flagState } = vi.hoisted(() => ({
  flagState: { flags: {} as Record<string, unknown> },
}));

/** Shared truth table. `evalFlag` returns `null` for "flag not found", like Flipt. */
function evalFlag(flag: string, entityId: string, context: Record<string, string>): boolean | null {
  const shape = (flagState.flags[flag] as FlagShape | undefined) ?? { kind: 'absent' };
  switch (shape.kind) {
    case 'absent':
      return null;
    case 'base':
      return shape.enabled;
    case 'segment':
      return shape.match(context) ? true : shape.base;
    case 'byEntity':
      return shape.match(entityId);
  }
}

vi.mock('~/server/flipt/client', () => ({
  // ASYNC: swallows "not found" and returns FALSE (see @civitai/flipt isEnabled).
  isFlipt: async (flag: string, entityId = 'global', context: Record<string, string> = {}) =>
    evalFlag(flag, entityId, context) ?? false,
  // SYNC: returns NULL for "not found" so the caller falls through to the static
  // availability (see @civitai/flipt isEnabledSync).
  isFliptSync: (flag: string, entityId = 'global', context: Record<string, string> = {}) =>
    evalFlag(flag, entityId, context),
  // Already "initialized" — the fake evaluates synchronously off `flagState`.
  ensureFliptInitialized: async () => undefined,
}));

import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import {
  APP_LISTINGS_PUBLIC_EXTERNAL_FLAG,
  isExternalListingsPublicEnabled,
  resolveStoreVisibilityScope,
} from '../app-blocks-flag';
import {
  getFeatureFlags,
  getFeatureFlagsAsync,
  getFeatureFlagsLazy,
} from '../feature-flags.service';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';

const EXTERNAL = APP_LISTINGS_PUBLIC_EXTERNAL_FLAG;
const LISTINGS = 'app-listings';
const BLOCKS = 'app-blocks-enabled';

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

/**
 * `getFeatureFlags` memoizes on (user identity, host, region) for 10s, so two cases
 * with the SAME user and DIFFERENT flag config would silently read one cached
 * answer — the whole matrix would then be one measurement repeated. Each call gets
 * a fresh host, which is part of the cache key and inert for these three flags
 * (none declares a server/color availability, so `serverMatch` is unconditionally
 * true). The `cache is actually bypassed` control below proves it works.
 */
let hostSeq = 0;
function makeReq(): NextApiRequest {
  return { headers: { host: `c${hostSeq++}.civitai.com` } } as unknown as NextApiRequest;
}

type Ctx = { user?: SessionUser; req: NextApiRequest | IncomingMessage };

beforeAll(async () => {
  // Prime the service's private `_fliptModule` (our mock) so the SYNC Flipt branch
  // inside `hasFeature` is live. Without this the branch is skipped entirely and
  // every flag falls to its static availability — the suite would still be green
  // and would be measuring nothing.
  await getFeatureFlagsAsync({ req: makeReq() });
});

beforeEach(() => {
  flagState.flags = {};
});

/** The client's view, taken through the EAGER path the `/apps` SSR resolver uses. */
function clientFeatures(user?: SessionUser) {
  return getFeatureFlags({ user, req: makeReq() } as Ctx);
}

/** Both halves of the seam, measured against one flag config. */
async function measure(user?: SessionUser) {
  const scope = await resolveStoreVisibilityScope({ user });
  const features = clientFeatures(user);
  const page = resolveAppsPageAccess({ features });
  return {
    scope,
    features,
    pageGranted: 'props' in page,
    predicate: hasAppsStoreAccess(features),
  };
}

// ---------------------------------------------------------------------------
// Instrument controls — a verdict from an unvalidated harness is worthless
// ---------------------------------------------------------------------------

describe('the harness (validate the instrument before reading its verdict)', () => {
  it('🔴 POSITIVE CONTROL: the Flipt branch is LIVE (a config change moves BOTH sides)', async () => {
    // Without this, a suite whose flags never take effect reports a reassuring
    // "everything agrees" — two sides agreeing because neither is wired to anything.
    const user = makeUser({ id: 555 });
    expect(clientFeatures(user).appListingsPublicExternal).toBeFalsy();
    await expect(isExternalListingsPublicEnabled({ user })).resolves.toBe(false);
    flagState.flags[EXTERNAL] = { kind: 'base', enabled: true } satisfies FlagShape;
    expect(clientFeatures(user).appListingsPublicExternal).toBe(true);
    await expect(isExternalListingsPublicEnabled({ user })).resolves.toBe(true);
  });

  it('🔴 KEY IDENTITY, proven behaviourally: both sides read the SAME Flipt key', async () => {
    // A typo in the client entry's `fliptKey` would make every agreement assertion
    // below pass vacuously (two flags nobody ever sets). Setting a NEIGHBOURING key
    // must move NEITHER side; setting the real one must move BOTH.
    const user = makeUser({ id: 558 });
    flagState.flags['app-listings-public-external-typo'] = {
      kind: 'base',
      enabled: true,
    } satisfies FlagShape;
    expect(clientFeatures(user).appListingsPublicExternal).toBeFalsy();
    await expect(isExternalListingsPublicEnabled({ user })).resolves.toBe(false);
    flagState.flags[EXTERNAL] = { kind: 'base', enabled: true } satisfies FlagShape;
    expect(clientFeatures(user).appListingsPublicExternal).toBe(true);
    await expect(isExternalListingsPublicEnabled({ user })).resolves.toBe(true);
  });

  it('🔴 the 10s feature-flag CACHE is actually bypassed between cases', () => {
    // If it were not, every case after the first would read a stale answer and the
    // matrix would be one measurement wearing many hats.
    const user = makeUser({ id: 556 });
    flagState.flags[EXTERNAL] = { kind: 'base', enabled: false } satisfies FlagShape;
    expect(clientFeatures(user).appListingsPublicExternal).toBeFalsy();
    flagState.flags[EXTERNAL] = { kind: 'base', enabled: true } satisfies FlagShape;
    expect(clientFeatures(user).appListingsPublicExternal).toBe(true);
  });

  it('🔴 the client entry is fail-closed for a MODERATOR when the flag is ABSENT', () => {
    // The behavioural form of "availability: [] and not ['mod']". This is the exact
    // mutant the entry's comment warns about: with `['mod']` the static fallback
    // would light this for a moderator while the SERVER's async eval — which has no
    // static fallback at all — returned false for the same absent flag.
    // The async/sync asymmetry is real and modelled: absent ⇒ false vs null.
    const mod = makeUser({ id: 557, isModerator: true });
    expect(clientFeatures(mod).appListingsPublicExternal).toBeFalsy();
    // Control: a `['mod']`-availability sibling flag DOES light up for the same
    // user under the same absent-flag conditions, so the assertion above is a fact
    // about THIS entry rather than about the harness.
    expect(clientFeatures(mod).appListings).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The seam itself
// ---------------------------------------------------------------------------

/**
 * The invariant, over every flag configuration the rollout can produce:
 *   page gate grants  ⟺  the server resolves a NON-EMPTY scope.
 */
describe('🔴 SEAM: page-gate access ⟺ a non-empty server scope', () => {
  const MOD_SEGMENT: FlagShape = {
    kind: 'segment',
    base: false,
    match: (ctx) => ctx.isModerator === 'true',
  };
  const TESTER_SEGMENT: FlagShape = {
    kind: 'segment',
    base: false,
    match: (ctx) => ctx.userId === '777' || ctx.userId === '778',
  };

  const users: Array<[string, SessionUser | undefined]> = [
    ['moderator', makeUser({ id: 1, isModerator: true })],
    ['app-dev-tester (app-listings)', makeUser({ id: 888 })],
    ['external tester (in segment)', makeUser({ id: 777 })],
    ['plain logged-in user', makeUser({ id: 555 })],
  ];

  const configs: Array<[string, Record<string, FlagShape>]> = [
    ['as-merged (external flag ABSENT)', { [BLOCKS]: MOD_SEGMENT, [LISTINGS]: TESTER_LISTINGS() }],
    [
      'external flag SEGMENTED to testers',
      { [BLOCKS]: MOD_SEGMENT, [LISTINGS]: TESTER_LISTINGS(), [EXTERNAL]: TESTER_SEGMENT },
    ],
    [
      'external flag base-ENABLED (the later public flip)',
      {
        [BLOCKS]: MOD_SEGMENT,
        [LISTINGS]: TESTER_LISTINGS(),
        [EXTERNAL]: { kind: 'base', enabled: true },
      },
    ],
    [
      'external flag base-DISABLED',
      {
        [BLOCKS]: MOD_SEGMENT,
        [LISTINGS]: TESTER_LISTINGS(),
        [EXTERNAL]: { kind: 'base', enabled: false },
      },
    ],
  ];

  function TESTER_LISTINGS(): FlagShape {
    return { kind: 'segment', base: false, match: (ctx) => ctx.userId === '888' };
  }

  for (const [configName, config] of configs) {
    for (const [userName, user] of users) {
      it(`${configName} × ${userName}`, async () => {
        flagState.flags = { ...config };
        const { scope, pageGranted, predicate } = await measure(user);
        expect(pageGranted, `scope=${scope}`).toBe(scope !== 'none');
        // …and the page result is exactly the shared predicate, so a future
        // re-inlining of the gate cannot slip past this.
        expect(predicate).toBe(pageGranted);
      });
    }
  }

  /**
   * 🔴 SCOPE OF THE CLAIM ABOVE — the matrix is deliberately restricted to
   * "Flipt is REACHABLE". It says nothing about a Flipt OUTAGE, and that is not an
   * oversight: a PRE-EXISTING divergence lives there, measured in the next describe.
   * Stating the boundary here so the biconditional is not read as unconditional.
   */
  it('the matrix is NON-VACUOUS: it produced all three scopes and both gate outcomes', async () => {
    const seen = new Set<string>();
    const gates = new Set<boolean>();
    for (const [, config] of configs) {
      for (const [, user] of users) {
        flagState.flags = { ...config };
        const { scope, pageGranted } = await measure(user);
        seen.add(scope);
        gates.add(pageGranted);
      }
    }
    expect([...seen].sort()).toEqual(['full', 'none', 'public-external']);
    expect([...gates].sort()).toEqual([false, true]);
  });
});

/**
 * 🔴 A PRE-EXISTING SEAM GAP, FOUND WHILE BUILDING THIS FILE — recorded, not fixed.
 *
 * When Flipt is UNREACHABLE (or a flag is absent) the two sides are asymmetric BY
 * DESIGN: the CLIENT gate falls through to each entry's static `availability`,
 * while the SERVER helpers have no static fallback at all and simply resolve
 * `false`. For a MODERATOR that means `appListings`/`appBlocks` resolve `true`
 * statically → the page gate GRANTS, while `resolveStoreVisibilityScope` resolves
 * `none` → the store is empty. A moderator during a Flipt outage therefore loads
 * `/apps` and sees nothing.
 *
 * That predates this change (it is a property of `app-listings` +
 * `app-blocks-enabled`, both `availability: ['mod']`), it is in the SAFE direction
 * (a mod sees an empty page; nobody sees anything they should not), and closing it
 * means giving the server a static mod floor — a behaviour change to the privileged
 * path, out of scope here. It is asserted rather than left implicit so it cannot be
 * mistaken for something this change introduced, and so a future fix has a test to
 * flip.
 *
 * What DOES hold for the new flag: the external-only cohort is dark on BOTH sides
 * during an outage. That is the property this change is responsible for.
 */
describe('🔴 Flipt DOWN: the new flag is dark on both sides (and the pre-existing mod gap is pinned)', () => {
  beforeEach(() => {
    flagState.flags = {}; // every flag absent === Flipt unreachable
  });

  it('the NEW flag fails closed on BOTH sides, for every cohort', async () => {
    for (const user of [
      makeUser({ id: 1, isModerator: true }),
      makeUser({ id: 777 }),
      makeUser({ id: 555 }),
      undefined,
    ]) {
      await expect(isExternalListingsPublicEnabled({ user })).resolves.toBe(false);
      expect(clientFeatures(user).appListingsPublicExternal).toBeFalsy();
    }
  });

  it('a non-privileged viewer is dark on both sides (no page, no scope)', async () => {
    const { scope, pageGranted } = await measure(makeUser({ id: 555 }));
    expect(scope).toBe('none');
    expect(pageGranted).toBe(false);
  });

  it('PRE-EXISTING (not introduced here): a MODERATOR gets the page but an empty scope', async () => {
    const { scope, pageGranted, features } = await measure(makeUser({ id: 1, isModerator: true }));
    expect(pageGranted).toBe(true);
    expect(scope).toBe('none');
    // …and it comes from the two OLD flags' `['mod']` static fallback, not the new
    // one — which is exactly why the new entry is `availability: []`.
    expect(features.appListings).toBe(true);
    expect(features.appBlocks).toBe(true);
    expect(features.appListingsPublicExternal).toBeFalsy();
  });
});

describe('🔴 the external-ONLY viewer: reachable, and scoped to offsite', () => {
  beforeEach(() => {
    // Deliberately NO app-listings / app-blocks-enabled grant for this user: the
    // external flag is their ONLY qualification.
    flagState.flags[EXTERNAL] = {
      kind: 'segment',
      base: false,
      match: (ctx) => ctx.userId === '777',
    } satisfies FlagShape;
  });

  it('reaches /apps — no notFound (the blocker this change removes)', async () => {
    const user = makeUser({ id: 777 });
    const { scope, pageGranted, features } = await measure(user);
    expect(scope).toBe('public-external');
    expect(pageGranted).toBe(true);
    // …and they hold NEITHER of the two older store flags, so the grant really did
    // come from the new term rather than from an accidental widening.
    expect(features.appListings).toBeFalsy();
    expect(features.appBlocks).toBeFalsy();
    expect(features.appListingsPublicExternal).toBe(true);
  });

  it('a viewer qualifying via NOTHING still gets notFound', async () => {
    const user = makeUser({ id: 555 });
    const { scope, pageGranted } = await measure(user);
    expect(scope).toBe('none');
    expect(pageGranted).toBe(false);
    expect(resolveAppsPageAccess({ features: clientFeatures(user) })).toEqual({ notFound: true });
  });

  it('🔴 does NOT widen any block-RUNTIME surface', async () => {
    // `/apps/installed`, `/apps/run/<slug>`, the `blocks.*` procs and the author
    // surfaces gate on `appBlocks` / `appBlocksPages` / `appBlocksAuthor` alone.
    // The external cohort must reach the CATALOG and nothing else.
    const features = clientFeatures(makeUser({ id: 777 }));
    expect(features.appBlocks).toBeFalsy();
    expect(features.appBlocksPages).toBeFalsy();
    expect(features.appBlocksAuthor).toBeFalsy();
    expect(features.appListings).toBeFalsy();
  });
});

describe('the eager and lazy client paths agree on the new key', () => {
  // `/apps` SSR uses eager (`getFeatureFlagsAsync`), tRPC uses lazy
  // (`getFeatureFlagsLazy`). A viewer whose page gate and API gate disagreed would
  // be a second seam.
  for (const shape of [
    { name: 'absent', flag: undefined },
    { name: 'base-enabled', flag: { kind: 'base', enabled: true } as FlagShape },
    {
      name: 'segmented',
      flag: {
        kind: 'segment',
        base: false,
        match: (ctx: Record<string, string>) => ctx.userId === '777',
      } as FlagShape,
    },
  ]) {
    it(`${shape.name}`, () => {
      if (shape.flag) flagState.flags[EXTERNAL] = shape.flag;
      for (const id of [777, 555]) {
        const user = makeUser({ id });
        const eager = getFeatureFlags({ user, req: makeReq() });
        const lazy = getFeatureFlagsLazy({ user, req: makeReq() });
        expect(!!lazy.appListingsPublicExternal, `id=${id}`).toBe(
          !!eager.appListingsPublicExternal
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The residual divergence — stated and measured, not papered over
// ---------------------------------------------------------------------------

/**
 * 🔴 THE ONE PLACE THE TWO SIDES CAN DISAGREE, pinned so it is a known bound rather
 * than a surprise. For an ANONYMOUS viewer the server evals with entityId
 * `'global'` and an EMPTY context (the byte-identical backward-compatible path the
 * brief requires), while the client gate evals with `'anonymous'` and
 * `{isLoggedIn:'false'}`. That is PRE-EXISTING for every flag in this family —
 * `app-listings` and `app-blocks-enabled` have always had it — and it is invisible
 * for the two flag shapes this rollout uses.
 */
describe('anon eval identity: agrees for the supported shapes, diverges only under a percentage rollout', () => {
  it('base-enabled → both sides TRUE for anon (the public flip works)', async () => {
    flagState.flags[EXTERNAL] = { kind: 'base', enabled: true } satisfies FlagShape;
    await expect(isExternalListingsPublicEnabled()).resolves.toBe(true);
    expect(clientFeatures(undefined).appListingsPublicExternal).toBe(true);
    expect(resolveAppsPageAccess({ features: clientFeatures(undefined) })).toEqual({ props: {} });
  });

  it('user-property segment → both sides FALSE for anon (anon carries no userId)', async () => {
    flagState.flags[EXTERNAL] = {
      kind: 'segment',
      base: false,
      match: (ctx) => ctx.userId === '777',
    } satisfies FlagShape;
    await expect(isExternalListingsPublicEnabled()).resolves.toBe(false);
    expect(clientFeatures(undefined).appListingsPublicExternal).toBeFalsy();
  });

  it('absent flag → both sides FALSE for anon (fail-closed together)', async () => {
    await expect(isExternalListingsPublicEnabled()).resolves.toBe(false);
    expect(clientFeatures(undefined).appListingsPublicExternal).toBeFalsy();
  });

  it('🔴 a PERCENTAGE/entityId rollout DOES diverge for anon — do not configure one', async () => {
    // The measured bound on the claim above. Matching only `'anonymous'` lights the
    // CLIENT gate while the server (`'global'`) stays dark: the viewer would load
    // /apps and get an empty store. Documented on APP_LISTINGS_PUBLIC_EXTERNAL_FLAG.
    flagState.flags[EXTERNAL] = {
      kind: 'byEntity',
      match: (entityId) => entityId === 'anonymous',
    } satisfies FlagShape;
    await expect(isExternalListingsPublicEnabled()).resolves.toBe(false);
    expect(clientFeatures(undefined).appListingsPublicExternal).toBe(true);
  });

  it('a LOGGED-IN viewer never diverges, even under an entityId rollout (same entityId)', async () => {
    flagState.flags[EXTERNAL] = {
      kind: 'byEntity',
      match: (entityId) => entityId === '777',
    } satisfies FlagShape;
    for (const id of [777, 555]) {
      const user = makeUser({ id });
      const server = await isExternalListingsPublicEnabled({ user });
      expect(!!clientFeatures(user).appListingsPublicExternal, `id=${id}`).toBe(server);
    }
  });
});
