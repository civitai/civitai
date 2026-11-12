import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as EventsUtils from '~/components/Events/events.utils';
import type * as HatTurfPlayer from '~/components/HatTurf/useHatTurfFeedPlayer';
import type * as DomainColor from '~/hooks/useDomainColor';
import type * as IsMobile from '~/hooks/useIsMobile';
import type * as Filters from '~/providers/FiltersProvider';
import type * as Trpc from '~/utils/trpc';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import {
  IMAGE_FEED_SEARCH_UNAVAILABLE_REASON,
  imageFeedFilterLabels,
  imageFeedSearchUnavailableKeys,
} from '~/components/Image/Infinite/image-feed-search';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const state = vi.hoisted(() => ({
  viewer: null as { id: number; isModerator?: boolean } | null,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.viewer }));
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof IsMobile>()),
  useIsMobile: () => false,
}));
vi.mock('~/hooks/useDomainColor', async (importOriginal) => ({
  ...(await importOriginal<typeof DomainColor>()),
  useDomainColor: () => 'blue',
}));
vi.mock('~/components/HatTurf/useHatTurfFeedPlayer', async (importOriginal) => ({
  ...(await importOriginal<typeof HatTurfPlayer>()),
  useHatTurfFeedPlayer: () => null,
}));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof EventsUtils>()),
  useTeamColor: () => undefined,
}));
vi.mock('~/providers/FiltersProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof Filters>()),
  useFiltersContext: (select: (filtersState: Record<string, unknown>) => unknown) =>
    select({ images: {}, setImageFilters: vi.fn() }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy(),
}));

async function openWhileSearching() {
  renderWithProviders(
    <MediaFiltersDropdown
      filterType="images"
      isFeed
      unavailable={{
        title: 'Not available while searching',
        reason: IMAGE_FEED_SEARCH_UNAVAILABLE_REASON,
        keys: imageFeedSearchUnavailableKeys,
        labels: imageFeedFilterLabels,
      }}
    />
  );
  await page.getByText('Filters').click();
  await expect.element(page.getByText('Not available while searching')).toBeVisible();
}

const greyed = (label: string) =>
  page.getByRole('checkbox', { name: label, exact: true, disabled: true });

describe('MediaFiltersDropdown while a search is set', () => {
  beforeEach(() => {
    state.viewer = { id: 1 };
  });

  test('greys the filters the search cannot apply instead of offering them', async () => {
    await openWhileSearching();
    await expect.element(greyed('Tools')).toBeInTheDocument();
    await expect.element(greyed('Remixes Only')).toBeInTheDocument();
    expect(
      page.getByRole('checkbox', { name: 'Remixes Only', exact: true, disabled: false }).query()
    ).toBeNull();
  });

  test('a regular viewer gets no moderator filters, greyed or not', async () => {
    await openWhileSearching();
    expect(greyed('POI').query()).toBeNull();
  });

  test('a moderator sees their filters greyed too', async () => {
    state.viewer = { id: 1, isModerator: true };
    await openWhileSearching();
    await expect.element(greyed('POI')).toBeInTheDocument();
  });
});
