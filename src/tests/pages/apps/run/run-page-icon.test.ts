import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
// Module scope, not a test body: from a body this transform is charged to one test's 60s
// budget. See vitest.config.mts.
import '~/pages/apps/run/[slug]/[[...path]]';

/**
 * The app RUN page resolves the listing ICON, and cannot be taken down by doing so.
 *
 * 🔴 THE DEFECT THIS COVERS IS AN ABSENCE, WHICH IS WHY IT NEEDS ITS OWN FILE. The page
 * writes a "recently opened apps" entry on every mount, and that store backs the chrome's
 * "Recently run" list. Every other writer goes through `toRecentAppFromListing` and carries
 * an `iconUrl`; this one could not, because nothing on this SSR path had ever read
 * `app_listings` for media — so the ONE writer that means "the viewer actually RAN this
 * app" was the one producing entries with no icon, and the chrome fell back to a generic
 * glyph for precisely the apps a viewer uses most. Nothing was broken in a way any test
 * could see: the field was simply never there.
 *
 * 🔴 THIS IS THE CLAIM ABOUT THE PAGE; `app-listing-icon.service.test.ts` IS THE CLAIM ABOUT
 * THE READER. "The reader degrades to null" and "the app still launches when the read
 * fails" are different assertions, and only the second is about the hazard — this page's
 * SSR does not decorate a card, it IS the app launch, and `createServerSideProps` has no
 * try/catch above it.
 *
 * It also pins the CONCURRENCY, a latency property nothing else can see: the icon read is
 * keyed on the SLUG so it need not wait for the block resolve. A refactor to key it on
 * `page.appBlockId` would compile, pass every other test, and silently add a serial round
 * trip to every app launch.
 *
 * Lives under `src/tests/` (NOT co-located under `src/pages/`) because Next treats every
 * file under `pages/` as a route — see the sibling maturity test.
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
 * The canonical `dbMock`, not a per-file mock of the db client module — a per-file mock of
 * a shared module freezes this file's shape into every later file in the same worker under
 * `isolate: false` (`no-direct-shared-module-mock.test.ts` fails a new one). The page reads
 * through the REAL `readListingIconBySlugForRender` against this client, so the degraded
 * branch is exercised end to end rather than stubbed at the reader boundary.
 *
 * 🔴 ONE MOCK SERVES TWO READERS, SO IT MUST BRANCH ON THE `select`. The beta read and the
 * icon read are both `dbRead.appListing.findUnique`. A flat `mockResolvedValue` would hand
 * the icon row to the beta reader and vice versa — which does not error, it just quietly
 * makes both assertions meaningless.
 */
const mockFindUnique = dbMock.dbRead.appListing.findUnique;

/** Route a `findUnique` call to the right fixture by looking at what it selected. */
function respond(opts: { icon?: unknown; iconThrows?: unknown }) {
  mockFindUnique.mockReset().mockImplementation(async (args: any) => {
    if (args?.select?.icon) {
      if (opts.iconThrows) throw opts.iconThrows;
      return opts.icon ?? null;
    }
    return null; // the beta read — not this file's subject
  });
}

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

beforeEach(() => {
  order.events = [];
  mockResolvePageBlockBySlug.mockReset().mockResolvedValue(PAGE);
  respond({ icon: null });
});

describe('run page — the listing icon reaches the props', () => {
  it('carries an `iconUrl` when the listing has an icon', async () => {
    respond({ icon: { icon: { url: 'icon-key-123' } } });
    const res = await run();

    // Asserted as "derived from the row", not as a literal CDN string: pinning the exact
    // URL would pin `getEdgeUrl`'s format — another module's contract — and go red on an
    // unrelated CDN change.
    expect(
      res.props.iconUrl,
      'the run page resolved no icon for a listing that HAS one — the "Recently run" entry ' +
        'this page writes will fall back to a generic glyph, which is the whole defect'
    ).toBeTruthy();
    expect(res.props.iconUrl).toContain('icon-key-123');
  });

  it.each([
    ['the listing has no icon assigned', { icon: null }],
    ['the icon row has a null url', { icon: { url: null } }],
    ['there is no listing row at all', null],
  ])('carries a null `iconUrl` when %s', async (_label, icon) => {
    respond({ icon });
    const res = await run();
    // 🔴 EXPLICIT `null`, NOT `undefined`. Next's SSR serialisation REJECTS `undefined` in
    // props ("cannot be serialized as JSON"), so a reader that returned undefined here
    // would 500 the launch page — the exact failure this whole path is built to avoid.
    expect(res.props.iconUrl).toBeNull();
  });

  it('keys the icon lookup on the SLUG and selects only the icon relation', async () => {
    await run('cool-app');
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { slug: 'cool-app' },
      select: { icon: { select: { url: true } } },
    });
  });

  it('🔴 issues the icon read CONCURRENTLY with the block resolve, not after it', async () => {
    // Both start before either resolves. A serial implementation — the shape you get by
    // keying the read on `page.appBlockId` — would order these
    // `resolve:start, resolve:end, icon:start, icon:end`, adding a round trip to every
    // single app launch.
    mockResolvePageBlockBySlug.mockReset().mockImplementation(async () => {
      order.events.push('resolve:start');
      await new Promise((r) => setTimeout(r, 5));
      order.events.push('resolve:end');
      return PAGE;
    });
    mockFindUnique.mockReset().mockImplementation(async (args: any) => {
      if (!args?.select?.icon) return null;
      order.events.push('icon:start');
      await new Promise((r) => setTimeout(r, 5));
      order.events.push('icon:end');
      return null;
    });

    await run();

    // Positive control: without it, a run in which the icon read never happened at all
    // would compare -1 < -1 → false and fail confusingly, or (with a different operator)
    // pass while observing nothing.
    expect(order.events, 'the icon read never ran').toContain('icon:start');
    expect(order.events.indexOf('icon:start')).toBeLessThan(order.events.indexOf('resolve:end'));
  });
});

describe('🔴 run page — the icon read FAILS OPEN; it can never take the app launch down', () => {
  it.each([
    [
      'the app_listings table is missing (42P01)',
      Object.assign(new Error('no relation'), { code: '42P01' }),
    ],
    ['the statement times out (57014)', Object.assign(new Error('canceling'), { code: '57014' })],
    ['the driver rejects with a non-Error', 'connection reset'],
  ])('still serves the app when %s', async (_label, err) => {
    respond({ iconThrows: err });
    const res = await run();

    // The app still opens…
    expect(
      res.props.appBlockId,
      'a failed ICON read stopped the app from launching. This read is cosmetic; ' +
        '`createServerSideProps` has no try/catch above it, so anything that propagates ' +
        'here is a 500 on the page that runs the app.'
    ).toBe('ab_1');
    expect(res.props.iframeSrc).toBe(PAGE.iframeSrc);
    // …and simply reports "no icon".
    expect(res.props.iconUrl).toBeNull();
  });
});
