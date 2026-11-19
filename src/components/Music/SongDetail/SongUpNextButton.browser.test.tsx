import '../../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as Trpc from '~/utils/trpc';

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const { withSongCoversStub } = await import('../../MusicPlayer/__tests__/song-covers-trpc-stub');
  return { ...actual, trpc: withSongCoversStub(actual.trpc) };
});
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useBrowsingLevelDebounced: () => 1,
}));

import { SongUpNextButton } from '~/components/Music/SongDetail/SongUpNextButton';
import { useMusicPlayerStore } from '~/store/music-player.store';

const player = () => useMusicPlayerStore.getState();
const song = (id: number, title: string) => ({
  id,
  url: `song-${id}`,
  title,
  durationSec: 200,
  creator: { id: 100 + id, username: `artist${id}` },
});

beforeEach(() => {
  player().close();
  player().playFromList({
    name: 'Post',
    tracks: [song(1, 'Midnight Arcade'), song(2, 'Palm Static')],
    index: 0,
  });
});

const openUpNext = async () => {
  await renderWithProviders(<SongUpNextButton />);
  await page.getByRole('button', { name: 'Up next' }).click();
};

test('on a phone, opens the Up next sheet', async () => {
  await page.viewport(390, 844);
  await openUpNext();
  await expect.element(page.getByRole('dialog', { name: 'Up next' })).toBeVisible();
  await expect.element(page.getByRole('region', { name: 'Up next' })).not.toBeInTheDocument();
});

test('on a desktop, opens the Up next panel as before', async () => {
  await page.viewport(1440, 900);
  await openUpNext();
  await expect.element(page.getByRole('region', { name: 'Up next' })).toBeVisible();
  await expect.element(page.getByRole('dialog', { name: 'Up next' })).not.toBeInTheDocument();
});
