import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import Router from 'next/router';
import { beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as Trpc from '~/utils/trpc';

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ music: true }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'image.getSongGenreTags': { useQuery: () => ({ data: { Pop: 11 }, isLoading: false }) },
    }),
  };
});
vi.mock('~/components/Image/Infinite/ImagesInfinite', () => ({ default: () => null }));
// The landing sections above the toolbar have their own tests.
vi.mock('~/components/Music/MusicLandingSections', () => ({
  RecentlyPlayedSection: () => null,
  RisingSection: () => null,
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/components/Filters/useSortAvailability', () => ({
  useSortAvailability: () => ({ isModerator: false, canViewNsfw: false, showNsfw: false }),
}));

import { SignedOutSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { MusicFeedPage } from '~/components/Music/MusicFeedPage';
import { FiltersProvider } from '~/providers/FiltersProvider';

beforeEach(() => {
  Router.query = {};
  Router.pathname = '/music';
});

// Pencil `ZYWeT`: view toggle, sort and Filters on one row, a phone included.
test('at phone width the toolbar keeps its three controls on one row, inside the page', async () => {
  await page.viewport(390, 844);
  await renderWithProviders(
    <SignedOutSessionProvider>
      <ContainerProvider containerName="main">
        <FiltersProvider>
          <MusicFeedPage />
        </FiltersProvider>
      </ContainerProvider>
    </SignedOutSessionProvider>
  );
  const toggle = page.getByRole('radiogroup', { name: 'View' });
  await expect.element(toggle).toBeVisible();
  const toolbar = toggle.element().parentElement!;
  const [first, ...rest] = [...toolbar.children].map((el) => el.getBoundingClientRect());
  expect(rest).toHaveLength(2);
  for (const control of rest) expect(control.top).toBeLessThan(first.bottom);
  expect(Math.max(...rest.map((r) => r.right))).toBeLessThanOrEqual(390);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});
