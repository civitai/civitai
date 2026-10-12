import { describe, expect, it, vi } from 'vitest';
import type * as ServerSideHelpers from '~/server/utils/server-side-helpers';

// Exposes the page's resolver directly, so the test drives the server render's prefetches.
vi.mock('~/server/utils/server-side-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerSideHelpers>()),
  createServerSideProps: ({ resolver }: { resolver: unknown }) => resolver,
}));

import { getServerSideProps } from '~/pages/user/[username]/index';

const PROFILE_ID = 42;

function fakeSsg(profile: { id: number } | null = { id: PROFILE_ID }) {
  const prefetch = () => vi.fn(async () => undefined);
  return {
    user: { getCreator: { prefetch: prefetch() } },
    userProfile: {
      get: {
        prefetch: prefetch(),
        fetch: vi.fn(async () => {
          if (!profile) throw new Error('not found');
          return profile;
        }),
      },
      overview: { prefetch: prefetch() },
    },
    creatorJourney: { isMilestoneShareable: { prefetch: prefetch() } },
  };
}

const resolve = async (query: Record<string, string>, ssg = fakeSsg()) => {
  const resolver = getServerSideProps as unknown as (args: unknown) => Promise<unknown>;
  await resolver({ ssg, ctx: { params: { username: query.username }, query } });
  return ssg.creatorJourney.isMilestoneShareable.prefetch;
};

// Crawlers read og:image from this render. Without the prefetch, a `?milestone=` link silently
// previews the profile picture instead of the card, with no error anywhere.
describe('profile page server render, ?milestone=', () => {
  it('prefetches whether the tier card renders, keyed as the layout queries it', async () => {
    const shareable = await resolve({ username: 'ellie', milestone: 'legend' });
    expect(shareable).toHaveBeenCalledWith({ userId: PROFILE_ID, milestone: 'legend' });
  });

  it('prefetches for a shared achievement too, named by its key', async () => {
    for (const milestone of ['reach:downloads-10000', 'hidden:vwjxua']) {
      const shareable = await resolve({ username: 'ellie', milestone });
      expect(shareable, milestone).toHaveBeenCalledWith({ userId: PROFILE_ID, milestone });
    }
  });

  // The layout queries `router.query.username` as typed. A prefetch under the slugified (lowercased)
  // name is a cache miss there, and `/user/JustMaier?milestone=` rendered with no og:image at all.
  it('prefetches under the route username as typed, not lowercased', async () => {
    const ssg = fakeSsg();
    await resolve({ username: 'JustMaier', milestone: 'supernova' }, ssg);
    for (const query of [
      ssg.user.getCreator.prefetch,
      ssg.userProfile.get.fetch,
      ssg.userProfile.overview.prefetch,
    ])
      expect(query).toHaveBeenCalledWith({ username: 'JustMaier' });

    const plain = fakeSsg();
    await resolve({ username: 'JustMaier' }, plain);
    expect(plain.userProfile.get.prefetch).toHaveBeenCalledWith({ username: 'JustMaier' });
  });

  it('does not look it up without the param, for a non-tier value, or for a missing user', async () => {
    expect(await resolve({ username: 'ellie' })).not.toHaveBeenCalled();
    expect(await resolve({ username: 'ellie', milestone: 'bogus' })).not.toHaveBeenCalled();
    expect(
      await resolve({ username: 'ellie', milestone: 'legend' }, fakeSsg(null))
    ).not.toHaveBeenCalled();
  });
});
