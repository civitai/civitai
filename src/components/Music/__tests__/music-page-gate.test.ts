import { describe, expect, it, vi } from 'vitest';

// Lives outside `src/pages/` because a test file there is a route to `next build`.

vi.mock('~/server/utils/server-side-helpers', () => ({
  // The config itself, so the resolver can be called directly.
  createServerSideProps: (config: unknown) => config,
}));
vi.mock('~/components/Music/MusicFeedPage', () => ({ MusicFeedPage: () => null }));
vi.mock('~/components/AppLayout/Page', () => ({ Page: (component: unknown) => component }));
vi.mock('~/components/AppLayout/FeedLayout', () => ({ FeedLayout: () => null }));

type Resolver = (args: { features?: { music?: boolean } }) => Promise<unknown>;

async function resolve(features: { music?: boolean }) {
  const { getServerSideProps } = (await import('~/pages/music')) as unknown as {
    getServerSideProps: { resolver: Resolver };
  };
  return getServerSideProps.resolver({ features });
}

describe('/music', () => {
  it('is not found with the music flag off', async () => {
    expect(await resolve({})).toEqual({ notFound: true });
  });

  it('renders with the music flag on', async () => {
    expect(await resolve({ music: true })).toEqual({ props: {} });
  });
});
