import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as Trpc from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';

const state = vi.hoisted(() => ({ features: {} as Record<string, boolean> }));

vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => state.features,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy({
    'userProfile.overview': {
      useQuery: () => ({
        data: { imageCount: 3, videoCount: 1, audioCount: 34 },
        isInitialLoading: false,
        isRefetching: false,
      }),
    },
    'userProfile.get': { useQuery: () => ({ data: { id: 7, username: 'alice' } }) },
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/components/UserSettings/hooks', () => ({ useCurrentUserSettings: () => ({}) }));
vi.mock('~/components/CreatorJourney/useProfileAchievements', () => ({
  useProfileAchievements: () => ({ count: 0 }),
}));

import { ProfileNavigation } from '~/components/Profile/ProfileNavigation';

const musicTab = () => page.getByRole('link', { name: /music/i });

beforeEach(() => {
  useRouter().pathname = '/user/[username]';
});

describe('the profile music tab', () => {
  test("shows with the music flag on, linking to the tab with the creator's song count", async () => {
    state.features = { music: true };
    renderWithProviders(<ProfileNavigation username="alice" />);

    await expect.element(musicTab()).toHaveAttribute('href', '/user/alice/music');
    await expect.element(musicTab()).toHaveTextContent('34');
  });

  test('is absent with the music flag off', async () => {
    state.features = {};
    renderWithProviders(<ProfileNavigation username="alice" />);

    await expect.element(page.getByRole('link', { name: /videos/i })).toBeInTheDocument();
    expect(musicTab().query()).toBeNull();
  });
});
