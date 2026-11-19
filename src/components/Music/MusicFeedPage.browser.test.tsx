import '@mantine/core/styles.layer.css';
import Router from 'next/router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as Trpc from '~/utils/trpc';

const genreTags = vi.hoisted(() => ({ Pop: 11, Synthwave: 29 }));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ music: true }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const image = new Proxy(actual.trpc.image, {
    get: (target, key) =>
      key === 'getSongGenreTags'
        ? { useQuery: () => ({ data: genreTags, isLoading: false }) }
        : Reflect.get(target, key),
  });
  const trpc = new Proxy(actual.trpc, {
    get: (target, key) => (key === 'image' ? image : Reflect.get(target, key)),
  });
  return { ...actual, trpc };
});
// The feed itself is `ImagesInfinite`; this probe shows what the page asks it for.
vi.mock('~/components/Image/Infinite/ImagesInfinite', () => ({
  default: ({
    filters,
    listItem,
    songListName,
  }: {
    filters: { types?: string[]; tags?: number[] };
    listItem?: unknown;
    songListName?: string;
  }) => (
    <div
      data-testid="feed"
      data-types={filters.types?.join(',')}
      data-tags={filters.tags?.join(',') ?? ''}
      data-view={listItem ? 'list' : 'card'}
      data-list-name={songListName}
    />
  ),
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
import { FiltersProvider } from '~/providers/FiltersProvider';

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
