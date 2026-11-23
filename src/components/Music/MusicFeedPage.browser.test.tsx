import '@mantine/core/styles.layer.css';
import Router from 'next/router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as Trpc from '~/utils/trpc';

const genreTags = vi.hoisted(() => ({ Pop: 11, Synthwave: 29 }));
const landing = vi.hoisted(() => ({
  rising: [] as number[],
  imageReads: [] as { ids?: number[]; tags?: number[] }[],
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ music: true }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const { withSongCoversStub } = await import('../MusicPlayer/__tests__/song-covers-trpc-stub');
  const stubbed = withSongCoversStub(actual.trpc);
  const image = {
    ...stubbed.image,
    getSongGenreTags: { useQuery: () => ({ data: genreTags, isLoading: false }) },
    getRisingSongs: { useQuery: () => ({ data: landing.rising }) },
  };
  const trpc = new Proxy(stubbed, {
    get: (target, key) => (key === 'image' ? image : Reflect.get(target, key)),
  });
  return { ...actual, trpc };
});
// The feed itself is `ImagesInfinite`; this probe shows what the page asks it for.
vi.mock('~/components/Image/Infinite/ImagesInfinite', () => ({
  default: ({
    filters,
    filterType,
    listItem,
    songListName,
  }: {
    filters: { types?: string[]; tags?: number[]; period?: string; baseModels?: string[] };
    filterType?: string;
    listItem?: unknown;
    songListName?: string;
  }) => (
    <div
      data-testid="feed"
      data-filter-type={filterType}
      data-period={filters.period}
      data-base-models={filters.baseModels?.join(',') ?? ''}
      data-types={filters.types?.join(',')}
      data-tags={filters.tags?.join(',') ?? ''}
      data-view={listItem ? 'list' : 'card'}
      data-list-name={songListName}
    />
  ),
}));
// The landing sections' songs, read by id through the image feed.
vi.mock('~/components/Music/useSongList', () => ({
  useSongList: (filters: { ids?: number[]; tags?: number[] }) => {
    landing.imageReads.push(filters);
    return {
      songs: (filters.ids ?? []).map((id) => ({
        id,
        url: `song-${id}.mp3`,
        type: 'audio',
        metadata: { title: `Song ${id}`, duration: 120 },
        user: { id: 100 + id, username: `artist${id}` },
        stats: {},
      })),
      isLoading: false,
    };
  },
}));
vi.mock('~/components/Music/SongContextMenu', () => ({
  SongContextMenu: () => null,
}));
vi.mock('~/components/Image/Providers/ImagesProvider', () => ({
  ImagesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useImagesContext: () => ({ getImages: () => undefined }),
}));
vi.mock('~/components/Filters/SortFilter', () => ({ SortFilter: () => null }));
vi.mock('~/components/Image/Filters/MediaFiltersDropdown', () => ({
  MediaFiltersDropdown: () => null,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/components/MasonryColumns/MasonryContainer', () => ({
  MasonryContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('~/components/Filters/useSortAvailability', () => ({
  useSortAvailability: () => ({ isModerator: false, canViewNsfw: false, showNsfw: false }),
}));

import { MusicFeedPage } from '~/components/Music/MusicFeedPage';
import { FiltersProvider, getInitialLocalStorageValues } from '~/providers/FiltersProvider';
import { useMusicPlayerStore } from '~/store/music-player.store';

const render = () =>
  renderWithProviders(
    <FiltersProvider>
      <MusicFeedPage />
    </FiltersProvider>
  );
const chip = (name: string) => page.getByRole('button', { name, exact: true });
const pickView = (name: string) => page.getByRole('radio', { name }).click();
const lastReplace = () => vi.mocked(Router.replace).mock.calls.at(-1)?.[0] as { query: object };

beforeEach(() => {
  landing.rising = [];
  landing.imageReads = [];
  useMusicPlayerStore.setState({ recentlyPlayed: [] });
  localStorage.clear();
  Router.query = {};
  Router.pathname = '/music';
  vi.mocked(Router.replace).mockClear();
});

afterEach(() => {
  Router.query = {};
  Router.pathname = '/';
});

describe('the /music page', () => {
  // /music keeps its own saved filters ("music-filters"), apart from /images ("image-filters").
  test('reads its own saved filters, never those saved on /images', async () => {
    localStorage.setItem(
      'image-filters',
      JSON.stringify({ period: 'AllTime', baseModels: ['SDXL 1.0'] })
    );
    localStorage.setItem('music-filters', JSON.stringify({ period: 'Month' }));
    await render();

    const feed = page.getByTestId('feed');
    await expect.element(feed).toHaveAttribute('data-filter-type', 'music');
    await expect.element(feed).toHaveAttribute('data-period', 'Month');
    await expect.element(feed).toHaveAttribute('data-base-models', '');
    await expect.element(feed).toHaveAttribute('data-types', 'audio');
  });

  test('saves songs as its media type by default', () => {
    expect(getInitialLocalStorageValues({ isRed: false }).music.types).toEqual(['audio']);
  });

  test('shows the title, the genre chips and the audio feed named "All music"', async () => {
    await render();
    await expect.element(page.getByRole('heading', { name: 'Music', level: 1 })).toBeVisible();
    await expect.element(chip('Pop')).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: 'All music' })).toBeVisible();
    await expect.element(page.getByTestId('feed')).toHaveAttribute('data-types', 'audio');
    await expect.element(page.getByTestId('feed')).toHaveAttribute('data-list-name', 'All music');
    await expect.element(page.getByTestId('feed')).toHaveAttribute('data-tags', '');
  });
});

describe('the landing sections', () => {
  const headings = () =>
    page
      .getByRole('heading')
      .elements()
      .map((el) => el.textContent);

  test('come in order: title, Recently played, Rising this week, All music', async () => {
    useMusicPlayerStore.setState({ recentlyPlayed: [4] });
    landing.rising = [7];
    await render();
    await expect.element(page.getByRole('heading', { name: 'Rising this week' })).toBeVisible();
    expect(headings()).toEqual(['Music', 'Recently played', 'Rising this week', 'All music']);
    // The chips sit between the title and the first section.
    const chips = chip('Pop').element();
    const recent = page.getByRole('heading', { name: 'Recently played' }).element();
    expect(chips.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('a first-time visitor with no plays this week sees only the feed', async () => {
    await render();
    await expect.element(page.getByRole('heading', { name: 'All music' })).toBeVisible();
    expect(headings()).toEqual(['Music', 'All music']);
  });

  test('Rising lists the picked genre only', async () => {
    Router.query = { tags: '29' };
    landing.rising = [7];
    await render();
    await expect.element(page.getByRole('heading', { name: 'Rising this week' })).toBeVisible();
    expect(landing.imageReads.find((read) => read.ids?.includes(7))?.tags).toEqual([29]);
  });
});

describe('the genre chips', () => {
  test('selecting a genre filters by its tag id, and All clears it', async () => {
    await render();
    await chip('Synthwave').click();
    expect(lastReplace().query).toEqual({ tags: [29] });

    await chip('All').click();
    expect(lastReplace().query).toEqual({});
  });

  test('a genre picked by link lights its chip and names the list after it', async () => {
    Router.query = { tags: '29' };
    await render();
    await expect.element(chip('Synthwave')).toHaveAttribute('data-active', 'true');
    await expect.element(page.getByTestId('feed')).toHaveAttribute('data-list-name', 'Synthwave');
    await expect.element(page.getByTestId('feed')).toHaveAttribute('data-tags', '29');
  });

  test('a ?tags= link that is not a genre lights no chip and can still be cleared', async () => {
    Router.query = { tags: '999' };
    await render();
    await expect.element(chip('All')).toBeInTheDocument();
    for (const name of ['All', 'Pop', 'Synthwave'])
      expect(chip(name).element().getAttribute('data-active')).toBeNull();
    await expect.element(page.getByTestId('feed')).toHaveAttribute('data-list-name', 'All music');

    await chip('All').click();
    expect(lastReplace().query).toEqual({});
  });
});

describe('the card / list view toggle', () => {
  test('switches the feed between cards and rows and is remembered after a remount', async () => {
    const first = await render();
    await expect.element(page.getByTestId('feed')).toHaveAttribute('data-view', 'card');
    await pickView('List view');
    await expect.element(page.getByTestId('feed')).toHaveAttribute('data-view', 'list');

    first.unmount();
    await render();
    await expect.element(page.getByTestId('feed')).toHaveAttribute('data-view', 'list');

    await pickView('Card view');
    await expect.element(page.getByTestId('feed')).toHaveAttribute('data-view', 'card');
  });
});
