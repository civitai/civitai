import { describe, it, expect, vi, beforeEach } from 'vitest';
// Module scope, not a test body: from a body this transform is charged to one test's
// 60s budget. See vitest.config.mts.
import '~/pages/apps/run/[slug]/[[...path]]';
// Type-only namespace import: an inline `typeof import('…')` is an ERROR under
// @typescript-eslint/consistent-type-imports, and this file is an ADDED file, where that
// gate BLOCKS. Erased at compile time, so it does not load the module mocked below.
import type * as PrivateRunAccessModule from '~/server/services/blocks/private-run-access.service';
// NOTE: the db client is NOT mocked here. Its canonical mock is registered globally in
// `src/__tests__/setup.ts`, and this file declares no behaviour on it — the route's
// database work is reached only through `resolvePrivateRunAccess` and `BlockRegistry`,
// both mocked below. Mocking that module directly is forbidden and caught by
// `no-direct-shared-module-mock.test.ts`; importing `dbMock` without declaring anything
// on it would just be an unused import.
//
// 🔴 DO NOT SPELL THAT FORBIDDEN CALL OUT IN A COMMENT HERE, even to say "don't do this".
// The guard matches a regex against RAW source, comments included, so naming the call
// verbatim makes this file a violator by DESCRIBING the violation — which is exactly what
// happened while writing this note, and it cost a CI round.

/**
 * THE PRIVATE-RUN BRANCH OF THE SSR RUN ROUTE — `/apps/run/<slug>`.
 *
 * ⚠️ THIS FILE USED TO TEST A SEPARATE ROUTE, `/apps/private-run/<slug>`, which was
 * REMOVED when the feature was rescoped. The private run is now a FALLBACK inside the
 * public run route's resolver, reached only when the approved-only
 * `resolvePageBlockBySlug` returns null. Every gate below still binds — they are the same
 * gates, reached through one more door — and the file was MOVED rather than rewritten so
 * the coverage is visibly carried across rather than silently re-created.
 *
 * 🔴 WHAT IS NEW HERE, AND WHY IT IS THE POINT OF THE MOVE: while the private run had its
 * own file, "a private run records no play" could be asserted by grepping that file for
 * `recordAppListingOpen`. One shared route cannot be checked that way — the identifier is
 * legitimately present for the public path — so the guard became BEHAVIOURAL: drive the
 * private branch, assert the recorder was not called, and pair it with a POSITIVE control
 * that drives the public branch and watches the same mock fire exactly once. A zero with
 * no positive control beside it is indistinguishable from a mock wired to nothing.
 *
 * [REG] in the literal sense only, and the distinction matters enough to spell out: the
 * feature does not exist at `f7f5eb4996`, so rows here are red there because the behaviour
 * is absent. That proves the feature was ADDED. It is NOT the same evidence as a row
 * watched red against a PRESENT-but-wrong implementation, and it must not be counted as if
 * it were. What proves each individual guard does the work its name claims is the MUTATION
 * matrix, not the label.
 *
 * NOTE: this test lives under `src/tests/` (NOT co-located under `src/pages/`). Next
 * treats every file under `pages/` as a route needing a default export, so a `*.test.ts`
 * there fails `next build`'s route-type validator (tsc and vitest do not catch it).
 *
 * ⚠️ FILES UNDER `src/tests/` ARE TYPECHECKED. `tsconfig.json` excludes only the
 * `__tests__` directories under `src`, so a type error in THIS file fails
 * `pnpm typecheck` — unlike the service tests next door, where one merges green. That
 * asymmetry is a reason to keep the page and mint tests here.
 *
 * 🔴 AND DO NOT WRITE A GLOB WITH A DOUBLE-STAR SEGMENT INSIDE A BLOCK COMMENT. The
 * first draft of this paragraph spelled that exclude pattern literally; the glob
 * contains the two characters that CLOSE a block comment, so the comment ended
 * mid-sentence, the remaining prose was parsed as code, and the suite died at import
 * with `ReferenceError: __tests__ is not defined`. It reported `Tests no tests` rather
 * than a failure — which is why the test COUNT, not the exit code, is the thing to read.
 */

const { capturedResolver } = vi.hoisted(() => ({
  capturedResolver: { fn: null as null | ((c: any) => Promise<any>) },
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (opts: { resolver: (c: any) => Promise<any> }) => {
    capturedResolver.fn = opts.resolver;
    return async () => ({ props: {} });
  },
}));

const { mockResolvePrivateRunAccess, mockFlag } = vi.hoisted(() => ({
  mockResolvePrivateRunAccess: vi.fn<(...a: any[]) => Promise<any>>(),
  mockFlag: vi.fn<(...a: any[]) => Promise<boolean>>(async () => true),
}));
// Partial, not wholesale — the SECOND instance of a hazard round 2 fixed once. A one-key
// factory makes every OTHER export of the module `undefined` at import time, so the day this
// file (or the route it imports) reads `PRIVATE_RUN_REFUSAL_REASONS`, a loop over it iterates
// nothing and the assertion passes having compared zero cases. Safe today — the route imports
// only `resolvePrivateRunAccess` — but "safe today" is what the mint test's factory was too.
vi.mock('~/server/services/blocks/private-run-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PrivateRunAccessModule>()),
  resolvePrivateRunAccess: mockResolvePrivateRunAccess,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksPrivateRunEnabled: mockFlag,
}));

// ── THE PUBLIC HALF OF THE SHARED ROUTE ─────────────────────────────────────────────
// The private run is a FALLBACK behind `resolvePageBlockBySlug` returning null, so this
// mock is what selects which branch the resolver takes. It defaults to `null` (⇒ private
// branch) in `beforeEach`; the positive-control tests set it to a real page to drive the
// PUBLIC branch through the very same resolver.
//
// 🔴 `recordAppListingOpen` IS THE INSTRUMENT THIS WHOLE FILE TURNS ON. The private
// branch must never call it — recording a play would move `views.count` /
// `views.uniqueViewers` on the owner's own analytics panel, which is precisely the
// number the feature's acceptance check reads. Asserting that zero is worthless without
// the paired positive control, so both live here.
const { mockResolvePageBlockBySlug, mockRecordOpen, mockRecordRecent } = vi.hoisted(() => ({
  mockResolvePageBlockBySlug: vi.fn<(...a: any[]) => Promise<any>>(),
  mockRecordOpen: vi.fn<(...a: any[]) => Promise<void>>(),
  mockRecordRecent: vi.fn<(...a: any[]) => void>(),
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolvePageBlockBySlug: mockResolvePageBlockBySlug },
}));
vi.mock('~/server/services/blocks/app-listing-open.service', () => ({
  recordAppListingOpen: mockRecordOpen,
}));
vi.mock('~/components/Apps/recentlyOpenedAppsStore', () => ({
  recordRecentlyOpenedApp: mockRecordRecent,
}));
// Both fail open to their "absent" value on the public path, so a stub that simply
// resolves is faithful rather than convenient.
vi.mock('~/server/services/blocks/app-listing-beta.service', () => ({
  readListingBetaBySlugForRender: async () => ({ isBeta: false, betaMessage: null }),
}));
vi.mock('~/server/services/blocks/app-listing-icon.service', () => ({
  readListingIconBySlugForRender: async () => null,
}));
// Real-ish host gate: mature (r/x) requires civitai.red.
vi.mock('~/server/utils/server-domain', () => ({
  ratingAllowedOnHost: (rating: unknown, host: string) => {
    const mature = typeof rating === 'string' && ['r', 'x'].includes(rating.toLowerCase());
    if (!mature) return true;
    return host === 'civitai.red' || host === 'www.civitai.red';
  },
}));

// The page imports React/Mantine bits at module top; stub the heavy ones so importing
// the page module in a node unit test does not pull a DOM.
vi.mock('@mantine/core', () => ({
  Alert: () => null,
  Box: () => null,
  useComputedColorScheme: () => 'dark',
}));
vi.mock('~/components/AppBlocks/PageBlockHost', () => ({ PageBlockHost: () => null }));
vi.mock('~/components/AppBlocks/useBlockToken', () => ({ useBlockToken: () => ({}) }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
// 🔴 BOTH ICONS THE ROUTE IMPORTS, not just the private-run one. This factory is
// WHOLESALE — every export not named here is `undefined` at import time — and the route
// merge widened what the module under test pulls: the shared route renders the beta
// notice (`IconFlask`) as well as the private-run notice (`IconEyeOff`). Listing only
// `IconEyeOff`, as this file did while it tested a separate route, leaves `IconFlask`
// undefined, which is the exact one-key-factory hazard called out on the
// `private-run-access.service` mock above.
vi.mock('@tabler/icons-react', () => ({ IconEyeOff: () => null, IconFlask: () => null }));

const BLOCK = (over: Record<string, unknown> = {}) => ({
  appBlockId: 'apb_privrun',
  blockId: 'seed-explorer-fixture',
  appId: 'app_privrun',
  status: 'suspended',
  approvedScopes: ['models:read:self'],
  manifest: {},
  iframeSrc: 'https://seed-explorer-fixture.civit.ai',
  sandbox: 'allow-scripts',
  trustTier: 'unverified' as const,
  name: 'Seed Explorer',
  pageTitle: 'Seed',
  scopes: ['models:read:self'],
  contentRating: 'g',
  bootSkeleton: false,
  currentVersionDeployedAt: new Date('2026-09-01'),
  ownerUserId: 4001,
  listingStatus: 'removed',
  ...over,
});

function ctx(opts: { host?: string; slug?: string; user?: unknown } = {}) {
  return {
    features: { appBlocks: true, appBlocksPages: true },
    ctx: {
      params: { slug: opts.slug ?? 'seed-explorer-fixture' },
      req: { headers: { host: opts.host ?? 'civitai.com' } },
    },
    session: opts.user === undefined ? { user: { id: 4004, isModerator: true } } : opts.user,
  };
}

/**
 * The page's captured `getServerSideProps` resolver.
 *
 * SYNCHRONOUS on purpose. An `async` accessor forced every call site into
 * `await resolver()(ctx())`, which prettier then wrapped across three lines and
 * which reads as two awaits of two different things. The capture itself is not async —
 * it happened at module import — so awaiting it was never anything but noise.
 */
function resolver(): (c: unknown) => Promise<any> {
  if (!capturedResolver.fn) throw new Error('resolver not captured');
  return capturedResolver.fn;
}

beforeEach(() => {
  mockResolvePrivateRunAccess.mockReset();
  mockFlag.mockReset();
  mockFlag.mockResolvedValue(true);
  mockResolvePageBlockBySlug.mockReset();
  // DEFAULT: the approved-only resolver finds nothing, which is the ONLY way the private
  // fallback is reachable. A test that wants the public branch overrides this explicitly.
  mockResolvePageBlockBySlug.mockResolvedValue(null);
  mockRecordOpen.mockReset();
  mockRecordOpen.mockResolvedValue(undefined);
  mockRecordRecent.mockReset();
});

describe('private-run SSR — the grant path [REG]', () => {
  it('an allowed moderator gets props, with the audience and status for the chrome', async () => {
    mockResolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'moderator',
      block: BLOCK(),
    });
    const res = await resolver()(ctx());
    expect(res.notFound).toBeUndefined();
    expect(res.props).toMatchObject({
      appBlockId: 'apb_privrun',
      blockId: 'seed-explorer-fixture',
      slug: 'seed-explorer-fixture',
      iframeSrc: 'https://seed-explorer-fixture.civit.ai',
      audience: 'moderator',
      privateRunStatus: 'suspended',
      trustTier: 'unverified',
      sandbox: 'allow-scripts',
    });
  });

  it('🔴 a private run records NO play', async () => {
    // THE analytics property the whole feature rests on. Recording this would move the
    // suspended app owner's own numbers — the exact reading the acceptance check performs.
    //
    // ⚠️ THIS ROW USED TO ALSO ASSERT `expect(mockRecordRecent).not.toHaveBeenCalled()`
    // AND THAT ASSERTION WAS VACUOUS — proven by mutation: deleting the guard left this
    // file fully green. `recordRecentlyOpenedApp` is called from a `useEffect` inside
    // `AppPage`, and this suite drives the SSR RESOLVER ONLY; it never renders the
    // component, so the effect never ran and the mock could never have been called
    // whatever the code did. Worse, two other files pointed AT this row as the coverage.
    // The recents decision is now a pure function with its own real tests below —
    // `shouldRecordRecents` — and the claim has been removed from here rather than
    // reworded. `recordAppListingOpen` is genuinely called from the RESOLVER, so that
    // half was always real and stays.
    mockResolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'moderator',
      block: BLOCK(),
    });
    const res = await resolver()(ctx());
    expect(res.notFound).toBeUndefined();
    expect(mockRecordOpen).not.toHaveBeenCalled();
  });

  it('🔴 POSITIVE CONTROL: the SAME mocks DO fire on the public branch', async () => {
    // Without this row the zero above is indistinguishable from a recorder wired to
    // nothing. Same resolver, same mock objects — only the approved-only resolve differs,
    // which is what proves the omission is the BRANCH and not the harness.
    mockResolvePageBlockBySlug.mockResolvedValue({
      appBlockId: 'apb_public',
      blockId: 'public-app',
      appId: 'app_public',
      iframeSrc: 'https://public-app.civit.ai',
      sandbox: 'allow-scripts',
      trustTier: 'unverified',
      name: 'Public App',
      pageTitle: 'Public',
      scopes: [],
      contentRating: 'g',
      bootSkeleton: false,
    });
    const res = await resolver()(ctx());
    expect(res.notFound).toBeUndefined();
    expect(mockRecordOpen).toHaveBeenCalledTimes(1);
    // And the public branch carries NO audience, so the chrome notice cannot render and
    // every private-only behaviour keyed on it stays off.
    expect(res.props).toMatchObject({ audience: null, privateRunStatus: null });
  });

  it('🔴 the private predicate is NOT consulted when the public resolve SUCCEEDS', async () => {
    // The ordering that makes one shared route safe: an approved app is served by the
    // public path and never touches the private predicate or the flag. If this ever
    // inverted, a public request would be taking an authorization decision it must not.
    mockResolvePageBlockBySlug.mockResolvedValue({
      appBlockId: 'apb_public',
      blockId: 'public-app',
      appId: 'app_public',
      iframeSrc: 'https://public-app.civit.ai',
      sandbox: 'allow-scripts',
      trustTier: 'unverified',
      name: 'Public App',
      pageTitle: 'Public',
      scopes: [],
      contentRating: 'g',
      bootSkeleton: false,
    });
    await resolver()(ctx());
    expect(mockResolvePrivateRunAccess).not.toHaveBeenCalled();
    expect(mockFlag).not.toHaveBeenCalled();
  });

  it('🔴 the predicate is called with the SLUG and the REPLICA pool', async () => {
    // The SSR side is a render path: it reads the replica, and the MINT re-resolves
    // against the primary before issuing any authority. Asserting the pool here is what
    // makes that division of labour a checked property rather than a comment.
    mockResolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'owner',
      block: BLOCK(),
    });
    await resolver()(ctx({ slug: 'another-slug' }));
    expect(mockResolvePrivateRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ by: { slug: 'another-slug' }, db: 'read' })
    );
  });

  it('the flag is evaluated FOR THE CALLER and threaded in', async () => {
    mockResolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'owner',
      block: BLOCK(),
    });
    await resolver()(ctx());
    expect(mockFlag).toHaveBeenCalledWith({ user: expect.objectContaining({ id: 4004 }) });
    expect(mockResolvePrivateRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ privateRunEnabled: true })
    );
  });

  it('🔴 an ANONYMOUS caller reaches NEITHER the flag accessor NOR the predicate', async () => {
    // THE PROPERTY, unchanged: `isAppBlocksPrivateRunEnabled` REQUIRES a user, so a
    // global evaluation — which would return the flag's BASE value rather than denying —
    // must be unreachable for an anonymous caller.
    //
    // ⚠️ THE SECOND ASSERTION CHANGED WITH THE ROUTE MERGE, AND IT IS A STRENGTHENING,
    // NOT A RELAXATION — stated because "the test changed to match the code" is exactly
    // how a guard gets quietly hollowed out. The removed route computed
    // `viewer ? await flag() : false` and then called the predicate ANYWAY, so the old
    // row asserted it was invoked with `privateRunEnabled: false` and let the predicate's
    // own gate (1) produce the refusal. The merged route returns `notFound` on the
    // missing viewer BEFORE either, so an anonymous request now touches no flag, no
    // predicate, and no database at all. That is a superset of the old guarantee: the old
    // form cannot be restored without making this row red.
    mockResolvePrivateRunAccess.mockResolvedValue({ allowed: false, reason: 'viewer-ineligible' });
    const res = await resolver()(ctx({ user: null }));
    expect(res).toEqual({ notFound: true });
    expect(mockFlag).not.toHaveBeenCalled();
    expect(mockResolvePrivateRunAccess).not.toHaveBeenCalled();
  });
});

describe('🔴 private-run SSR — NO EXISTENCE ORACLE [REG]', () => {
  // 🔴 DERIVED FROM THE RUNTIME TUPLE, NOT HAND-COPIED — and the hand-copied version was
  // ALREADY WRONG, which is the whole argument for deriving it. It listed eight of the
  // nine reasons and omitted `no-iframe-src`, so that refusal was asserted by nothing
  // under a heading claiming EVERY refusal is indistinguishable.
  //
  // `PRIVATE_RUN_REFUSAL_REASONS` exists as a runtime tuple for exactly this: its own
  // docblock says a test enumerating reasons against a hand-written array "stays GREEN
  // when a ninth member is added to the union and has no coverage, under a comment
  // claiming the enumeration is complete." That is what had happened here. The module
  // mock spreads `importOriginal`, so the real tuple is in scope.
  let reasons: readonly string[] = [];
  beforeEach(async () => {
    ({ PRIVATE_RUN_REFUSAL_REASONS: reasons } = await import(
      '~/server/services/blocks/private-run-access.service'
    ));
  });

  it('EVERY refusal reason produces the IDENTICAL bare notFound', async () => {
    // Deep equality against the missing-app baseline, for the same reason the mint test
    // does it: a distinguishable refusal tells a signed-in prober which delisted slugs
    // exist, which are theirs, and which are undeployed.
    mockResolvePrivateRunAccess.mockResolvedValue({ allowed: false, reason: 'no-app' });
    const baseline = await resolver()(ctx());
    expect(baseline).toEqual({ notFound: true });

    // POSITIVE CONTROL ON THE ENUMERATION ITSELF. `reasons` is now resolved at runtime,
    // so an import that silently yielded `undefined` or `[]` would make the loop below
    // iterate nothing and this test pass having compared zero cases — the precise failure
    // the tuple exists to prevent, reintroduced by the fix for it. Assert the floor and
    // the one member the hand-written list had omitted.
    expect(reasons.length).toBeGreaterThanOrEqual(9);
    expect(reasons).toContain('no-iframe-src');

    for (const reason of reasons) {
      mockResolvePrivateRunAccess.mockResolvedValue({ allowed: false, reason });
      const got = await resolver()(ctx());
      expect(got, `reason "${reason}" must be indistinguishable from a missing app`).toEqual(
        baseline
      );
      // And no `props` leak — a `notFound` carrying props would ship the block's
      // identity to a caller who was refused.
      expect(got.props).toBeUndefined();
    }
  });

  it('🔴 POSITIVE CONTROL: the comparison CAN distinguish the allowed response', async () => {
    mockResolvePrivateRunAccess.mockResolvedValue({ allowed: false, reason: 'no-app' });
    const baseline = await resolver()(ctx());
    mockResolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'moderator',
      block: BLOCK(),
    });
    const granted = await resolver()(ctx());
    expect(granted).not.toEqual(baseline);
    expect(granted.props).toBeDefined();
  });

  it('a resolved app with NO iframeSrc gets the same bare notFound', async () => {
    mockResolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'moderator',
      block: BLOCK({ iframeSrc: '' }),
    });
    expect(await resolver()(ctx())).toEqual({ notFound: true });
  });
});

describe('private-run SSR — the inherited gates [REG]', () => {
  it('both public page flags are still required, BEFORE anything is resolved', async () => {
    mockResolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'moderator',
      block: BLOCK(),
    });
    for (const features of [
      { appBlocks: false, appBlocksPages: true },
      { appBlocks: true, appBlocksPages: false },
      { appBlocks: false, appBlocksPages: false },
    ]) {
      const c = ctx();
      const res = await resolver()({ ...c, features });
      expect(res).toEqual({ notFound: true });
    }
    // The tell that the gate really is first: the predicate was never consulted.
    expect(mockResolvePrivateRunAccess).not.toHaveBeenCalled();
  });

  it('an empty slug is refused without resolving', async () => {
    const res = await resolver()(ctx({ slug: '' }));
    expect(res).toEqual({ notFound: true });
    expect(mockResolvePrivateRunAccess).not.toHaveBeenCalled();
  });

  it('🔴 MATURITY: an r-rated app 404s on .com and renders on .red', async () => {
    // The forced-SFW token ceiling plus this host gate, both kept from the public route.
    // Vacuous in production today (every suspended block is `g` except one `pg`), so the
    // fixture is synthetic on purpose — and that is exactly why it must be tested here:
    // there is no production row that would exercise it.
    mockResolvePrivateRunAccess.mockResolvedValue({
      allowed: true,
      audience: 'moderator',
      block: BLOCK({ contentRating: 'r' }),
    });
    expect(await resolver()(ctx({ host: 'civitai.com' }))).toEqual({ notFound: true });
    const onRed = await resolver()(ctx({ host: 'civitai.red' }));
    expect(onRed.props).toBeDefined();
  });

  it('the maturity gate runs AFTER access, so it cannot be probed by an outsider', async () => {
    // Ordering: a refused viewer must not be able to learn an app's content rating by
    // comparing hosts. Both answers are the same bare notFound.
    mockResolvePrivateRunAccess.mockResolvedValue({ allowed: false, reason: 'no-role' });
    expect(await resolver()(ctx({ host: 'civitai.com' }))).toEqual({ notFound: true });
    expect(await resolver()(ctx({ host: 'civitai.red' }))).toEqual({ notFound: true });
  });
});

describe('the private-run chrome copy [REG]', () => {
  it('🔴 a PENDING app says the last APPROVED build is being served', async () => {
    // The sentence that stops a reviewer reviewing the wrong bytes. A re-submitted app
    // is `pending`, and what is DEPLOYED — and therefore running — is still the last
    // approved build, not the submitted one.
    const { privateRunNotice } = await import('~/pages/apps/run/[slug]/[[...path]]');
    const pending = privateRunNotice({ audience: 'moderator', status: 'pending' });
    expect(pending).toMatch(/re-submitted/i);
    expect(pending).toMatch(/last approved build/i);
    expect(pending).toMatch(/not the submitted one/i);
  });

  it('a suspended app says it is not publicly listed or runnable', async () => {
    const { privateRunNotice } = await import('~/pages/apps/run/[slug]/[[...path]]');
    const copy = privateRunNotice({ audience: 'moderator', status: 'suspended' });
    expect(copy).toMatch(/not publicly listed/i);
    expect(copy).toMatch(/last approved build/i);
  });

  it('each audience is told WHY it is here, and an editor is told it is read-only', async () => {
    const { privateRunNotice } = await import('~/pages/apps/run/[slug]/[[...path]]');
    expect(privateRunNotice({ audience: 'moderator', status: 'suspended' })).toMatch(
      /as a moderator/i
    );
    expect(privateRunNotice({ audience: 'owner', status: 'suspended' })).toMatch(/your own app/i);
    const editor = privateRunNotice({ audience: 'editor', status: 'suspended' });
    expect(editor).toMatch(/collaborator/i);
    // 🔴 The read-only fact is in the COPY, not only in the clamp. An editor whose
    // generate button silently does nothing reads the app as broken; told up front, they
    // report the right thing.
    expect(editor).toMatch(/generation is disabled/i);
  });

  it('POSITIVE CONTROL: the copy actually varies across audience and status', async () => {
    // Four assertions above would all pass against a constant string if it happened to
    // contain every phrase. Prove the function discriminates.
    const { privateRunNotice } = await import('~/pages/apps/run/[slug]/[[...path]]');
    const variants = new Set([
      privateRunNotice({ audience: 'owner', status: 'suspended' }),
      privateRunNotice({ audience: 'editor', status: 'suspended' }),
      privateRunNotice({ audience: 'moderator', status: 'suspended' }),
      privateRunNotice({ audience: 'moderator', status: 'pending' }),
    ]);
    expect(variants.size).toBe(4);
  });
});

/**
 * ── THE TWO CLIENT-SIDE DECISIONS ────────────────────────────────────────────────
 *
 * 🔴 THIS BLOCK EXISTS BECAUSE ITS TWO PROPERTIES WERE PREVIOUSLY ASSERTED BY NOTHING,
 * AND ONE OF THEM WAS ASSERTED BY SOMETHING VACUOUS, WHICH IS WORSE. Both decisions live
 * inside `AppPage`, which this suite never renders — it drives the SSR resolver only. So:
 *
 *   · the recents guard was "covered" by `expect(mockRecordRecent).not.toHaveBeenCalled()`
 *     in a test that never triggers the effect. Deleting the guard left the file GREEN.
 *   · the `surface` prop had NO assertion in the repo. Replacing the ternary with a
 *     constant `'page-run'` left 51 tests green across three files.
 *
 * Both are now pure exported functions, so the DECISION is testable in node without a
 * renderer. These rows fail on the mutation that the previous arrangement survived.
 *
 * ⚠️ WHAT THIS STILL DOES NOT PROVE, stated rather than glossed: that the COMPONENT calls
 * them. A pure function nothing calls is the obvious next way for this to go quiet, and it
 * would not be caught here. That half is pinned structurally in
 * `private-run-access.call-site-ledger.test.ts`; neither check is sufficient alone.
 */
describe('the audience-keyed client decisions [REG]', () => {
  it('🔴 the host surface is `private-run` for EVERY private audience, `page-run` only when public', async () => {
    // The surface carries an unconditional BLOCK_INIT fragment refusal. Collapsing a
    // private audience onto `page-run` hands a suspended app a fast path its own gate
    // denies — and the allowlist is non-empty today, so that is reachable.
    const { hostSurfaceFor } = await import('~/pages/apps/run/[slug]/[[...path]]');
    expect(hostSurfaceFor('moderator')).toBe('private-run');
    expect(hostSurfaceFor('owner')).toBe('private-run');
    expect(hostSurfaceFor('editor')).toBe('private-run');
    // POSITIVE CONTROL — without this the three rows above pass against a function that
    // returns `'private-run'` unconditionally, which would break every public render.
    expect(hostSurfaceFor(null)).toBe('page-run');
  });

  it('🔴 a private run gets NO recents entry, and a public one gets a usable one', async () => {
    // Both link shapes the recents rail builds 404 for a delisted app once the flag
    // narrows, so an entry written here is a rail row that breaks later.
    //
    // ⚠️ THIS TESTED A BOOLEAN `shouldRecordRecents` UNTIL AN AUDIT INVERTED THE `!` AT ITS
    // CALL SITE AND WATCHED 151 TESTS ACROSS 8 FILES STAY GREEN. The boolean was fine; the
    // POLARITY at the call site was the untested part, and no test of a predicate can see
    // it. `recentsEntryFor` returns the entry or `null`, so the call site has no `!` to
    // invert and the inverted form does not type-check.
    const { recentsEntryFor } = await import('~/pages/apps/run/[slug]/[[...path]]');
    const args = { appBlockId: 'apb_x', blockId: 'cool-app', appName: 'Cool', iconUrl: null };
    expect(recentsEntryFor({ ...args, audience: 'moderator' })).toBeNull();
    expect(recentsEntryFor({ ...args, audience: 'owner' })).toBeNull();
    expect(recentsEntryFor({ ...args, audience: 'editor' })).toBeNull();
    // POSITIVE CONTROL — a function returning `null` always would silently disable the
    // recents rail for every public run, and the three rows above cannot see that. Assert
    // the entry is USABLE, not merely non-null: a truthy but malformed object would be
    // dropped by the store's own acceptance gate and read here as coverage.
    const pub = recentsEntryFor({ ...args, audience: null });
    expect(pub).toMatchObject({ id: 'apb_x', blockId: 'cool-app', kind: 'onsite', hasPage: true });
  });

  it('the recents entry carries the listing icon only when there is one', async () => {
    // `RecentApp.iconUrl` is OPTIONAL and the store keeps the key only when truthy, so an
    // absent icon must leave the key OFF rather than write `undefined`.
    const { recentsEntryFor } = await import('~/pages/apps/run/[slug]/[[...path]]');
    const args = { audience: null, appBlockId: 'apb_x', blockId: 'cool-app', appName: 'Cool' };
    expect(recentsEntryFor({ ...args, iconUrl: 'https://cdn/i.png' })).toMatchObject({
      iconUrl: 'https://cdn/i.png',
    });
    expect(Object.keys(recentsEntryFor({ ...args, iconUrl: null })!)).not.toContain('iconUrl');
  });

  it('🔴 the two decisions are EXACT COMPLEMENTS across the audience domain', async () => {
    // They are separate functions with separate reasons, so nothing structurally forces
    // them to agree — but a private render must both take the private surface AND skip
    // recents. Enumerated over the audience tuple rather than a hand-written list, so a
    // FOURTH audience added to `PRIVATE_RUN_AUDIENCES` lands here with no coverage gap.
    const { hostSurfaceFor, recentsEntryFor } = await import('~/pages/apps/run/[slug]/[[...path]]');
    const args = { appBlockId: 'apb_x', blockId: 'cool-app', appName: 'Cool', iconUrl: null };
    const { PRIVATE_RUN_AUDIENCES } = await import('~/shared/constants/block-scope.constants');
    expect(PRIVATE_RUN_AUDIENCES.length).toBeGreaterThan(0);
    for (const a of PRIVATE_RUN_AUDIENCES) {
      expect(hostSurfaceFor(a)).toBe('private-run');
      expect(recentsEntryFor({ ...args, audience: a })).toBeNull();
    }
    expect(hostSurfaceFor(null)).toBe('page-run');
    expect(recentsEntryFor({ ...args, audience: null })).not.toBeNull();
  });
});
