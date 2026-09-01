import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
// Module scope, not a test body: from a body this transform is charged to one test's 60s
// budget. See vitest.config.mts.
import '~/pages/apps/run/[slug]/[[...path]]';

/**
 * The BETA notice on the app RUN page (`/apps/run/<slug>`) — and above all, its FAILURE
 * POSTURE.
 *
 * 🔴 WHY THIS FILE EXISTS SEPARATELY FROM THE READER'S OWN UNIT TESTS. This page's SSR does
 * not decorate a card — it IS the app launch. A throw in the resolver is a 500 on the page
 * that runs the app, so "the guarded reader degrades" is a claim about the reader, and this
 * is the claim about the PAGE: whatever the beta lookup does, the props still resolve and
 * the app still opens. The two are different assertions and only the second one is about
 * the hazard.
 *
 * It also pins the CONCURRENCY, which is a latency property nothing else can see: the beta
 * read is keyed on the SLUG precisely so it does not have to wait for the block resolve, and
 * a "harmless" refactor to `readListingBeta(page.appBlockId)` would silently add a serial
 * round trip to every app launch while every other test stayed green.
 *
 * Lives under `src/tests/` (NOT co-located under `src/pages/`) for the reason the sibling
 * maturity test documents: Next treats every file under `pages/` as a route.
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

const { mockResolvePageBlockBySlug, order } = vi.hoisted(() => ({
  mockResolvePageBlockBySlug: vi.fn<(...a: any[]) => Promise<any>>(),
  order: { events: [] as string[] },
}));

vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolvePageBlockBySlug: mockResolvePageBlockBySlug },
}));

/**
 * 🔴 THE CANONICAL `dbMock`, NOT A PER-FILE MOCK OF THE DB CLIENT MODULE. A per-file mock of
 * a shared module freezes THIS file's mock shape into every later file in the same worker
 * under `isolate: false`, which is why `no-direct-shared-module-mock.test.ts` fails a new
 * one. See docs/testing/shared-module-mocks.md.
 *
 * The page still reads the beta columns through the REAL guarded reader against this client,
 * so the degraded branch is exercised end to end rather than stubbed at the reader boundary.
 */
const mockFindUnique = dbMock.dbRead.appListing.findUnique;

vi.mock('~/server/utils/server-domain', () => ({ ratingAllowedOnHost: () => true }));

vi.mock('@mantine/core', () => ({
  Alert: () => null,
  Box: () => null,
  useComputedColorScheme: () => 'dark',
}));
vi.mock('@tabler/icons-react', () => ({ IconFlask: () => null }));
vi.mock('~/components/AppBlocks/PageBlockHost', () => ({ PageBlockHost: () => null }));
vi.mock('~/components/AppBlocks/useBlockToken', () => ({ useBlockToken: () => ({}) }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

const PAGE = {
  appBlockId: 'ab_1',
  blockId: 'cool-app',
  appId: 'app_1',
  iframeSrc: 'https://cool-app.civit.ai',
  sandbox: 'allow-scripts',
  trustTier: 'unverified' as const,
  name: 'Cool App',
  pageTitle: 'Cool',
  scopes: [],
  contentRating: 'g',
};

function ctx(slug = 'cool-app') {
  return {
    features: { appBlocks: true, appBlocksPages: true },
    ctx: { params: { slug }, req: { headers: { host: 'civitai.com' } } },
  };
}

async function run(slug = 'cool-app') {
  if (!capturedResolver.fn) throw new Error('resolver not captured');
  return capturedResolver.fn(ctx(slug));
}

/** A Prisma-shaped "column does not exist" error. */
function missingColumnError(code = 'P2022'): Error {
  const err = new Error('The column `app_listings.is_beta` does not exist') as Error & {
    code?: string;
  };
  err.code = code;
  return err;
}

beforeEach(() => {
  order.events = [];
  mockResolvePageBlockBySlug.mockReset().mockResolvedValue(PAGE);
  mockFindUnique.mockReset().mockResolvedValue(null);
});

describe('run page — the beta props', () => {
  it('carries the flag and note when the listing declares beta', async () => {
    mockFindUnique.mockResolvedValue({ isBeta: true, betaMessage: 'Rough edges ahead.' });
    const res = await run();
    expect(res.props.isBeta).toBe(true);
    expect(res.props.betaMessage).toBe('Rough edges ahead.');
  });

  it('a beta listing with NO note still gets the flag (the note is optional)', async () => {
    mockFindUnique.mockResolvedValue({ isBeta: true, betaMessage: null });
    const res = await run();
    expect(res.props.isBeta).toBe(true);
    expect(res.props.betaMessage).toBeNull();
  });

  it('does NOT carry a stale note when the flag is off', async () => {
    // A row can hold a note from an author who later turned beta off; the page must not
    // resurrect it. Same rule every other projection of these columns applies.
    mockFindUnique.mockResolvedValue({ isBeta: false, betaMessage: 'old note' });
    const res = await run();
    expect(res.props.isBeta).toBe(false);
    expect(res.props.betaMessage).toBeNull();
  });

  it('keys the lookup on the SLUG, and selects ONLY the two beta columns', async () => {
    // 🔴 The slug key is what makes the concurrency below possible; re-keying it on
    // `page.appBlockId` would compile, pass every other test, and add a serial hop to the
    // app-launch path. The narrow `select` is the manual-apply discipline.
    await run('cool-app');
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { slug: 'cool-app' },
      select: { isBeta: true, betaMessage: true },
    });
  });

  it('🔴 issues the beta read CONCURRENTLY with the block resolve, not after it', async () => {
    // Both are started before either resolves. A serial implementation would order the
    // events `resolve:start, resolve:end, beta:start, beta:end`.
    mockResolvePageBlockBySlug.mockReset().mockImplementation(async () => {
      order.events.push('resolve:start');
      await new Promise((r) => setTimeout(r, 5));
      order.events.push('resolve:end');
      return PAGE;
    });
    mockFindUnique.mockReset().mockImplementation(async () => {
      order.events.push('beta:start');
      await new Promise((r) => setTimeout(r, 5));
      order.events.push('beta:end');
      return null;
    });

    await run();

    expect(order.events.indexOf('beta:start')).toBeLessThan(order.events.indexOf('resolve:end'));
  });
});

describe('🔴 run page — the beta read FAILS OPEN; it can never take the app launch down', () => {
  it.each([
    ['the manual-apply migration has not run (P2022)', missingColumnError('P2022')],
    ['Postgres reports 42703 (undefined_column)', missingColumnError('42703')],
  ])('still serves the app when %s', async (_label, err) => {
    mockFindUnique.mockRejectedValue(err);
    const res = await run();
    // The app still opens…
    expect(res.props.appBlockId).toBe('ab_1');
    expect(res.props.iframeSrc).toBe(PAGE.iframeSrc);
    // …and simply reports "not beta".
    expect(res.props.isBeta).toBe(false);
    expect(res.props.betaMessage).toBeNull();
  });

  it('serves the app when the slug has NO store listing at all', async () => {
    // A block with no `AppListing` row is an ordinary state — it must not 404 the launch.
    mockFindUnique.mockResolvedValue(null);
    const res = await run();
    expect(res.props.appBlockId).toBe('ab_1');
    expect(res.props.isBeta).toBe(false);
  });

  it('positive control — the resolver CAN still 404, so "it served" is not vacuous', async () => {
    // Without this, every assertion above would also pass on a resolver that returns props
    // unconditionally. This shows the same harness reaches the not-found branch.
    mockResolvePageBlockBySlug.mockResolvedValue(null);
    const res = await run();
    expect(res).toEqual({ notFound: true });
  });

  it('a NON-missing-column database error is NOT swallowed', async () => {
    // 🔴 THE NARROWNESS OF THE GUARD, asserted at the page level. Degrading on a real
    // outage would turn it into a silently missing badge — the failure this posture exists
    // to avoid, reached from the other side. A missing TABLE (42P01) is a half-applied
    // schema and must surface.
    const err = new Error('relation does not exist') as Error & { code?: string };
    err.code = '42P01';
    mockFindUnique.mockRejectedValue(err);
    await expect(run()).rejects.toBe(err);
  });
});
