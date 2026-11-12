import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `ssr-client-only-sections` seam on the two routes that use it: `getServerSideProps` puts the
 * switch in the page props, and the page component hands it to `ClientOnlySectionsProvider`, so a
 * `ClientOnlySection` anywhere under the page renders its placeholder on the server exactly when
 * the switch is on. The page bodies are probes holding one `ClientOnlySection`; what each body
 * wraps is pinned next to it (`ImageDetail2.clientOnlySections.browser.test.tsx`,
 * `ClientOnlySection.browser.test.tsx`).
 *
 * Lives under `src/tests/` because a test file under `src/pages/` is a route to `next build`.
 */

const m = vi.hoisted(() => ({ on: false }));

vi.mock('~/server/utils/server-side-helpers', () => ({
  // The config itself, so the resolver can be called directly.
  createServerSideProps: (config: unknown) => config,
}));
vi.mock('~/server/utils/ssr-client-only-sections', () => ({
  ssrClientOnlySectionsOn: () => m.on,
}));

vi.mock('~/server/page-data/image-detail', () => ({
  resolveImageDetailPageData: vi.fn(async ({ ctx }: { ctx: { params?: { imageId?: string } } }) =>
    ctx.params?.imageId === 'nope'
      ? { notFound: true }
      : { props: {}, gating: { contentNsfwLevel: 1 } }
  ),
}));
vi.mock('~/server/services/post.service', () => ({
  getPostDetail: vi.fn(async () => ({
    id: 5,
    availability: 'Public',
    nsfwLevel: 1,
    nsfw: false,
    publishedAt: new Date('2026-11-01'),
  })),
}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/utils/browsing-level', () => ({
  getServerBrowsingLevel: () => 1,
  getServerImageQueryFilters: async () => null,
}));

// The page bodies: one deferred section each, under whatever provider the page puts above them.
vi.mock('~/components/Image/Detail/ImageDetailPage', async () => {
  const { ClientOnlySection } = await import('~/components/ClientOnlySection/ClientOnlySection');
  return {
    ImageDetailPage: () =>
      createElement(
        ClientOnlySection,
        // `children` arrives as the third argument, which the props type cannot see.
        { name: 'probe' } as never,
        createElement('span', { 'data-testid': 'probe-section' })
      ),
  };
});
vi.mock('~/components/Post/Detail/PostDetail', async () => {
  const { ClientOnlySection } = await import('~/components/ClientOnlySection/ClientOnlySection');
  return {
    PostDetail: () =>
      createElement(
        ClientOnlySection,
        // `children` arrives as the third argument, which the props type cannot see.
        { name: 'probe' } as never,
        createElement('span', { 'data-testid': 'probe-section' })
      ),
  };
});

type Resolver = (args: unknown) => Promise<{ props?: Record<string, unknown>; notFound?: true }>;
type PageModule = {
  getServerSideProps: { resolver: Resolver };
  default: (props: Record<string, unknown>) => ReactNode;
};

const imagePage = (await import('~/pages/images/[imageId]')) as unknown as PageModule;
const postPage = (await import('~/pages/posts/[postId]/[[...postSlug]]')) as unknown as PageModule;

const ROUTES = [
  { name: '/images/[imageId]', page: imagePage, params: { imageId: '123' } },
  { name: '/posts/[postId]', page: postPage, params: { postId: '5' } },
] as const;

const resolve = (page: PageModule, params: Record<string, string>) =>
  page.getServerSideProps.resolver({
    ctx: { params, query: {} },
    ssg: undefined,
    session: null,
    features: {},
  });

const serverRender = (page: PageModule, props: Record<string, unknown>) =>
  renderToString(createElement(page.default as never, props as never));

beforeEach(() => {
  m.on = false;
});

describe.each(ROUTES)('$name', ({ page, params }) => {
  it('switch off: the props say off, and the server renders the section', async () => {
    m.on = false;
    const result = await resolve(page, params);
    expect(result.props).toHaveProperty('ssrClientOnlySections', false);
    const html = serverRender(page, result.props!);
    expect(html).toContain('data-testid="probe-section"');
    expect(html).not.toContain('data-client-only-section');
  });

  it('switch on: the props say on, and the server renders the placeholder instead', async () => {
    m.on = true;
    const result = await resolve(page, params);
    expect(result.props).toHaveProperty('ssrClientOnlySections', true);
    const html = serverRender(page, result.props!);
    expect(html).not.toContain('data-testid="probe-section"');
    expect(html).toContain('data-client-only-section="probe"');
  });
});

describe('/images/[imageId] resolver', () => {
  it('passes a 404 through untouched', async () => {
    m.on = true;
    expect(await resolve(imagePage, { imageId: 'nope' })).toEqual({ notFound: true });
  });

  it('keeps the ad-gating declaration of the shared resolver', async () => {
    const result = (await resolve(imagePage, { imageId: '123' })) as { gating?: unknown };
    expect(result.gating).toEqual({ contentNsfwLevel: 1 });
  });
});
