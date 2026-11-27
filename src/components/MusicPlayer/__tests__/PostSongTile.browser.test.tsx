import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { postSongList, PostSongCard } from '~/components/MusicPlayer/PostSong';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';

const song = (id: number, title: string) => ({
  id,
  url: `song-${id}`,
  metadata: { title, duration: 100 },
  user: { id: 4, username: 'neonwave' },
});
const first = song(1, 'Neon Prayer');
const second = song(2, 'Grey Weather');
const list = postSongList('Test post', [first, second]);

const initial = useMusicPlayerStore.getState();
beforeEach(() => useMusicPlayerStore.setState(initial, true));
afterEach(() => vi.restoreAllMocks());

describe('the post page song card', () => {
  test('clicking along the waveform of a song not playing starts it from there', async () => {
    const playFromList = vi.spyOn(useMusicPlayerStore.getState(), 'playFromList');
    renderWithProviders(<PostSongCard song={second} list={list} />);

    const slider = page.getByRole('slider', { name: 'Grey Weather progress' });
    await expect.element(slider).toHaveAttribute('aria-valuetext', '0:00 of 1:40');
    const rect = slider.element().getBoundingClientRect();
    await slider.click({ position: { x: rect.width / 4, y: rect.height / 2 } });

    expect(playFromList).toHaveBeenCalledOnce();
    const [{ startAtSec, index, tracks }] = playFromList.mock.calls[0];
    expect(tracks[index].id).toBe(2);
    expect(startAtSec).toBeGreaterThan(20);
    expect(startAtSec).toBeLessThan(30);
  });

  test("shows the global player's progress only on the song that is playing", async () => {
    useMusicPlayerStore.getState().playFromList({
      name: 'Test post',
      tracks: [first, second].map((s) => ({
        id: s.id,
        url: s.url,
        title: s.metadata.title,
        durationSec: 100,
        creator: { id: 4, username: 'neonwave' },
      })),
      index: 0,
    });
    useMusicPlayheadStore.setState({ currentTime: 36, duration: 100 });
    renderWithProviders(
      <>
        <PostSongCard song={first} list={list} />
        <PostSongCard song={second} list={list} />
      </>
    );

    await expect
      .element(page.getByRole('slider', { name: 'Neon Prayer progress' }))
      .toHaveAttribute('aria-valuetext', '0:36 of 1:40');
    await expect
      .element(page.getByRole('slider', { name: 'Grey Weather progress' }))
      .toHaveAttribute('aria-valuetext', '0:00 of 1:40');
    await expect.element(page.getByRole('button', { name: 'Pause Neon Prayer' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Play Grey Weather' })).toBeVisible();
  });

  test('shows the play count after the length, abbreviated', async () => {
    renderWithProviders(<PostSongCard song={first} list={list} plays={1204} />);
    await expect.element(page.getByLabelText('1204 plays')).toHaveTextContent('1.2k');
  });

  test('opens the song from its title and its cover', async () => {
    renderWithProviders(<PostSongCard song={first} list={list} />);
    // The image detail route, for this song's id, from both.
    for (const name of ['Neon Prayer', 'Open Neon Prayer'])
      await expect
        .element(page.getByRole('link', { name, exact: true }))
        .toHaveAttribute('href', expect.stringMatching(/^\/images\/1(\?|$)/));
  });
});
