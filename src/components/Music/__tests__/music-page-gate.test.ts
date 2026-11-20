import { describe, expect, it, vi } from 'vitest';

// Lives outside `src/pages/` because a test file there is a route to `next build`.

const banned = vi.hoisted(() => ({ lookups: 0 }));

vi.mock('~/server/utils/server-side-helpers', () => ({
  // The config itself, so the resolver can be called directly.
  createServerSideProps: (config: unknown) => config,
}));
vi.mock('~/server/services/user-banned-at.service', () => ({
  getUserBannedAtByUsername: async () => {
    banned.lookups++;
    return null;
  },
}));
vi.mock('~/components/Music/MusicFeedPage', () => ({ MusicFeedPage: () => null }));
vi.mock('~/components/Image/Infinite/UserMediaInfinite', () => ({ UserMediaInfinite: () => null }));
vi.mock('~/components/Profile/ProfileLayout2', () => ({ UserProfileLayout: () => null }));
vi.mock('~/components/AppLayout/Page', () => ({ Page: (component: unknown) => component }));
vi.mock('~/components/AppLayout/FeedLayout', () => ({ FeedLayout: () => null }));

type Resolver = (args: {
  features?: { music?: boolean };
  ctx?: { query: Record<string, string> };
}) => Promise<unknown>;

async function resolve(page: string, features: { music?: boolean }) {
  const { getServerSideProps } = (await import(page)) as {
    getServerSideProps: { resolver: Resolver };
  };
  return getServerSideProps.resolver({ features, ctx: { query: { username: 'alice' } } });
}

describe('/music', () => {
  it('is not found with the music flag off', async () => {
    expect(await resolve('~/pages/music', {})).toEqual({ notFound: true });
  });

  it('renders with the music flag on', async () => {
    expect(await resolve('~/pages/music', { music: true })).toEqual({ props: {} });
  });
});

describe('/user/[username]/music', () => {
  it('is not found with the music flag off, before any lookup', async () => {
    banned.lookups = 0;
    expect(await resolve('~/pages/user/[username]/music', {})).toEqual({ notFound: true });
    expect(banned.lookups).toBe(0);
  });

  it('renders with the music flag on', async () => {
    expect(await resolve('~/pages/user/[username]/music', { music: true })).toBeUndefined();
  });
});
