import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ServerDomain from '~/server/utils/server-domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// Module scope, not a test body: from a body this transform is charged to one test's 60s
// budget (see the sibling run-page tests this harness is cloned from).
import RunPage from '~/pages/apps/run/[slug]/[[...path]]';

/**
 * "OPENING CLEARS THE HIDE" — the run page's half (`openingClearsHide`, my-apps-hidden.ts).
 * A hide is cleared server-side when the signed-in viewer opens the app's run route, so a hide
 * made on one device does not outlive a reopen on another. Pinned here:
 *   1. `getServerSideProps` reads the viewer's hide for THIS slug only when signed in, and
 *      turns it into `isHiddenForViewer`; a failing read cannot take the launch away;
 *   2. the page mounts the clearing component exactly once, for this slug, only when the
 *      prop is true — so an ordinary open makes no write.
 * The component's "one unhide per mount" is `ReopenClearsHide.browser.test.tsx`.
 */

const m = vi.hoisted(() => ({
  resolver: null as null | ((c: any) => Promise<any>),
  resolvePageBlockBySlug: vi.fn<(...a: any[]) => Promise<any>>(),
  isMyAppHidden: vi.fn<(a: { userId: number; slug: string }) => Promise<boolean>>(),
  reopenRenders: [] as Array<Record<string, unknown>>,
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (opts: { resolver: (c: any) => Promise<any> }) => {
    m.resolver = opts.resolver;
    return async () => ({ props: {} });
  },
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolvePageBlockBySlug: m.resolvePageBlockBySlug },
}));
vi.mock('~/server/services/blocks/app-listing-open.service', () => ({
  recordAppListingOpen: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/my-apps-hidden.service', () => ({
  isMyAppHidden: m.isMyAppHidden,
}));
// `next/dynamic` with `ssr: false` renders nothing on the server, so the page's one
// `dynamic(...)` (the clearing component) is replaced by a recorder of what it was given.
vi.mock('next/dynamic', () => ({
  default: () => (props: Record<string, unknown>) => {
    m.reopenRenders.push(props);
    return null;
  },
}));
vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerDomain>()),
  ratingAllowedOnHost: () => true,
}));
vi.mock('@mantine/core', () => ({
  Box: ({ children }: { children?: unknown }) => children ?? null,
  Alert: () => null,
  useComputedColorScheme: () => 'dark',
}));
vi.mock('~/components/AppBlocks/useBlockToken', () => ({
  useBlockToken: () => ({ token: 't', error: null, missingScopes: [], signedScopes: [] }),
}));
vi.mock('~/components/AppBlocks/PageBlockHost', () => ({ PageBlockHost: () => null }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: true }),
}));

const PAGE = {
  appBlockId: 'ab_1',
  blockId: 'cool-app',
  appId: 'app_1',
  iframeSrc: 'https://cool-app.civit.ai/',
  sandbox: 'allow-scripts',
  trustTier: 'unverified' as const,
  name: 'Cool App',
  pageTitle: 'Cool',
  scopes: [],
  contentRating: 'g',
};

function ctxFor(session: unknown) {
  return {
    features: { appBlocks: true, appBlocksPages: true },
    session,
    ctx: {
      params: { slug: 'cool-app' },
      query: { slug: 'cool-app' },
      req: { headers: { host: 'civitai.com' } },
      res: {},
    },
  };
}

async function propsFor(session: unknown) {
  if (!m.resolver) throw new Error('resolver not captured');
  const result = await m.resolver(ctxFor(session));
  expect(result, 'the launch must resolve to props (positive control)').toHaveProperty('props');
  return result.props as Record<string, unknown>;
}

/** Render the page from real resolver props; returns what the clearing component was given. */
async function reopenRendersFor(session: unknown) {
  const props = await propsFor(session);
  m.reopenRenders = [];
  renderToStaticMarkup(createElement(RunPage as any, props));
  return m.reopenRenders;
}

beforeEach(() => {
  m.resolvePageBlockBySlug.mockReset().mockResolvedValue({ ...PAGE });
  m.isMyAppHidden.mockReset().mockResolvedValue(false);
  m.reopenRenders = [];
});

describe('/apps/run/[slug] — opening clears a My apps hide', () => {
  it('🔴 a hidden slug: the clearing component renders exactly once, for that slug', async () => {
    m.isMyAppHidden.mockResolvedValue(true);
    const renders = await reopenRendersFor({ user: { id: 7 } });
    expect(m.isMyAppHidden.mock.calls).toEqual([[{ userId: 7, slug: 'cool-app' }]]);
    expect(renders).toEqual([{ slug: 'cool-app' }]);
  });

  it('🔴 a slug that is not hidden: nothing renders, so no write is made', async () => {
    const renders = await reopenRendersFor({ user: { id: 7 } });
    expect(m.isMyAppHidden).toHaveBeenCalledTimes(1); // positive control: the read ran
    expect(renders).toEqual([]);
  });

  it('🔴 signed out: no read and nothing renders', async () => {
    // Stubbed TRUE so a missing session check would visibly render the component.
    m.isMyAppHidden.mockResolvedValue(true);
    expect(await reopenRendersFor(null)).toEqual([]);
    expect(await reopenRendersFor({})).toEqual([]);
    expect(m.isMyAppHidden).not.toHaveBeenCalled();
  });

  it('the prop is the read: true only when the viewer has the hide', async () => {
    m.isMyAppHidden.mockResolvedValue(true);
    expect((await propsFor({ user: { id: 7 } })).isHiddenForViewer).toBe(true);
    m.isMyAppHidden.mockResolvedValue(false);
    expect((await propsFor({ user: { id: 7 } })).isHiddenForViewer).toBe(false);
  });
});
