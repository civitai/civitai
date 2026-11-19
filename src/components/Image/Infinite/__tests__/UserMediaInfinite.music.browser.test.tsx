import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as Trpc from '~/utils/trpc';
import { UserMediaInfinite } from '~/components/Image/Infinite/UserMediaInfinite';
import { MediaType } from '~/shared/utils/prisma/enums';
import { renderWithProviders } from '../../../../../test/component-setup';

const state = vi.hoisted(() => ({
  feed: undefined as { filters: Record<string, unknown>; songListName?: string } | undefined,
  viewer: null as { id: number; username: string } | null,
}));

vi.mock('~/components/Filters/useSortAvailability', () => ({
  useSortAvailability: () => ({ isModerator: false, canViewNsfw: true, showNsfw: true }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.viewer }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: (await import('../../../../../test/trpcProxyStub')).makeTrpcProxy({
    'userProfile.get': {
      useQuery: () => ({ data: { id: 7, username: 'Alice' }, isLoading: false }),
    },
  }),
}));
// What the profile asks its feed for; the feed itself is covered by the ImagesInfinite tests.
vi.mock('~/components/Image/Infinite/ImagesInfinite', () => ({
  default: (props: { filters: Record<string, unknown>; songListName?: string }) => {
    state.feed = props;
    return null;
  },
}));
vi.mock('~/components/Image/Filters/MediaFiltersDropdown', () => ({
  MediaFiltersDropdown: () => null,
}));

beforeEach(() => {
  state.feed = undefined;
  state.viewer = null;
  useRouter().query = { username: 'alice' };
});

describe('the profile music tab', () => {
  test("lists only the creator's songs, playing them as a list named after the creator", async () => {
    renderWithProviders(<UserMediaInfinite type={MediaType.audio} />);

    await expect.poll(() => state.feed?.filters.userId).toBe(7);
    expect(state.feed?.filters.types).toEqual([MediaType.audio]);
    expect(state.feed?.songListName).toBe('Alice');
  });

  test('keeps the Published / Draft toggle on the owner’s own profile', async () => {
    state.viewer = { id: 7, username: 'Alice' };
    renderWithProviders(<UserMediaInfinite type={MediaType.audio} />);

    await expect.element(page.getByText('My Songs')).toBeVisible();
    await expect.element(page.getByText('Draft')).toBeVisible();
  });

  test('the images tab names no song list', async () => {
    renderWithProviders(<UserMediaInfinite type={MediaType.image} />);

    await expect.poll(() => state.feed?.filters.userId).toBe(7);
    expect(state.feed?.songListName).toBeUndefined();
  });
});
