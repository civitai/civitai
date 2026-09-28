import { describe, it, expect, vi, beforeEach } from 'vitest';
// Module scope, not a test body: from a body this transform is charged to one test's
// 60s budget. See vitest.config.mts.
import '~/pages/apps/private-run/[slug]/[[...path]]';

/**
 * THE PRIVATE-RUN SSR ROUTE — `/apps/private-run/<slug>`. All [REG]: the route does not
 * exist at `f7f5eb4996`.
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
vi.mock('~/server/services/blocks/private-run-access.service', () => ({
  resolvePrivateRunAccess: mockResolvePrivateRunAccess,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksPrivateRunEnabled: mockFlag,
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
vi.mock('@tabler/icons-react', () => ({ IconEyeOff: () => null }));

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
      status: 'suspended',
      trustTier: 'unverified',
      sandbox: 'allow-scripts',
    });
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

  it('🔴 an ANONYMOUS caller never reaches the flag accessor at all', async () => {
    // `isAppBlocksPrivateRunEnabled` REQUIRES a user, so a global evaluation — which
    // would return the flag's BASE value rather than denying — must be unreachable. The
    // route short-circuits to `false` instead.
    mockResolvePrivateRunAccess.mockResolvedValue({ allowed: false, reason: 'viewer-ineligible' });
    const res = await resolver()(ctx({ user: null }));
    expect(res).toEqual({ notFound: true });
    expect(mockFlag).not.toHaveBeenCalled();
    expect(mockResolvePrivateRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ privateRunEnabled: false })
    );
  });
});

describe('🔴 private-run SSR — NO EXISTENCE ORACLE [REG]', () => {
  const reasons = [
    'flag-off',
    'viewer-ineligible',
    'no-app',
    'approved',
    'not-a-page',
    'no-role',
    'owner-banned',
    'not-deployed',
  ] as const;

  it('EVERY refusal reason produces the IDENTICAL bare notFound', async () => {
    // Deep equality against the missing-app baseline, for the same reason the mint test
    // does it: a distinguishable refusal tells a signed-in prober which delisted slugs
    // exist, which are theirs, and which are undeployed.
    mockResolvePrivateRunAccess.mockResolvedValue({ allowed: false, reason: 'no-app' });
    const baseline = await resolver()(ctx());
    expect(baseline).toEqual({ notFound: true });

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
    const { privateRunNotice } = await import('~/pages/apps/private-run/[slug]/[[...path]]');
    const pending = privateRunNotice({ audience: 'moderator', status: 'pending' });
    expect(pending).toMatch(/re-submitted/i);
    expect(pending).toMatch(/last approved build/i);
    expect(pending).toMatch(/not the submitted one/i);
  });

  it('a suspended app says it is not publicly listed or runnable', async () => {
    const { privateRunNotice } = await import('~/pages/apps/private-run/[slug]/[[...path]]');
    const copy = privateRunNotice({ audience: 'moderator', status: 'suspended' });
    expect(copy).toMatch(/not publicly listed/i);
    expect(copy).toMatch(/last approved build/i);
  });

  it('each audience is told WHY it is here, and an editor is told it is read-only', async () => {
    const { privateRunNotice } = await import('~/pages/apps/private-run/[slug]/[[...path]]');
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
    const { privateRunNotice } = await import('~/pages/apps/private-run/[slug]/[[...path]]');
    const variants = new Set([
      privateRunNotice({ audience: 'owner', status: 'suspended' }),
      privateRunNotice({ audience: 'editor', status: 'suspended' }),
      privateRunNotice({ audience: 'moderator', status: 'suspended' }),
      privateRunNotice({ audience: 'moderator', status: 'pending' }),
    ]);
    expect(variants.size).toBe(4);
  });
});
