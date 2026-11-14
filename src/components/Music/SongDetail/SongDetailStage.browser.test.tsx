import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as MusicPlayerAudio from '~/components/MusicPlayer/MusicPlayerAudio';
import type * as MoreFromCreator from '~/components/Music/SongDetail/useMoreFromCreator';
import type { LyricLine } from '~/server/schema/media.schema';
import type * as Trpc from '~/utils/trpc';

const lyrics = vi.hoisted(() => ({
  lines: null as LyricLine[] | null,
  status: 'success' as 'success' | 'loading' | 'error',
  queried: [] as { id: number; enabled?: boolean }[],
}));
const moreFrom = vi.hoisted(() => ({ songs: [] as unknown[] }));
const seek = vi.hoisted(() => vi.fn());
/** The song current in the player at each seek, so a seek that lands on the old song shows. */
const seekedSongs = vi.hoisted(() => [] as (number | undefined)[]);

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy({
    'image.getSongLyrics': {
      useQuery: (input: { id: number }, options?: { enabled?: boolean }) => {
        lyrics.queried.push({ id: input.id, enabled: options?.enabled });
        if (options?.enabled === false) return { data: undefined, isLoading: false };
        if (lyrics.status === 'loading') return { data: undefined, isLoading: true };
        if (lyrics.status === 'error') return { data: undefined, isLoading: false, isError: true };
        return { data: lyrics.lines, isLoading: false, isError: false };
      },
    },
  }),
}));
vi.mock('~/components/Music/SongDetail/useMoreFromCreator', async (importOriginal) => ({
  ...(await importOriginal<typeof MoreFromCreator>()),
  useMoreFromCreator: () => ({
    songs: moreFrom.songs,
    name: 'More from neonwave',
    isLoading: false,
  }),
}));
vi.mock('~/components/MusicPlayer/MusicPlayerAudio', async (importOriginal) => ({
  ...(await importOriginal<typeof MusicPlayerAudio>()),
  seekMusicPlayer: seek,
}));

import { SongDetailStage } from '~/components/Music/SongDetail/SongDetailStage';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';

const song = (id: number, title: string, duration = 178) => ({
  id,
  url: `song-${id}.mp3`,
  metadata: { title, duration },
  user: { id: 7, username: 'neonwave' },
});
const midnight = song(1, 'Midnight Arcade');
const palm = song(2, 'Palm Static');

const TIMED: LyricLine[] = [
  { t: null, text: '[Verse 1]' },
  { t: 1000, text: 'Coins in the slot' },
  { t: 5000, text: 'Every high score' },
  { t: null, text: 'hums in blue' },
  { t: 9000, text: 'Joystick heartbeat' },
];

const player = () => useMusicPlayerStore.getState();
const line = (name: string) => page.getByRole('button', { name, exact: true });
const lyricsBox = () => page.getByTestId('song-lyrics');

function render(revealed = true) {
  return renderWithProviders(<SongDetailStage image={midnight} revealed={revealed} />);
}

beforeEach(() => {
  player().close();
  useMusicPlayheadStore.setState({ currentTime: 0, duration: 0 });
  lyrics.lines = TIMED;
  lyrics.status = 'success';
  lyrics.queried = [];
  moreFrom.songs = [palm];
  seekedSongs.length = 0;
  seek.mockReset().mockImplementation(() => {
    seekedSongs.push(useMusicPlayerStore.getState().current?.id);
  });
});

describe('the song stage', () => {
  test("shows the song's title, creator and length, and opening it plays nothing", async () => {
    await render();
    await expect
      .element(page.getByRole('heading', { name: 'Midnight Arcade' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('link', { name: 'neonwave' }))
      .toHaveAttribute('href', '/user/neonwave');
    await expect.element(page.getByText('· 2:58')).toBeInTheDocument();
    expect(player().current).toBeNull();
  });

  test('plays through the global player, with the creator’s other songs as Up next', async () => {
    await render();
    await page.getByRole('button', { name: 'Play Midnight Arcade' }).click();

    expect(player().current?.id).toBe(1);
    expect(player().playing).toBe(true);
    // Up next shows "Next from neonwave"; "More from" is the card's title.
    expect(player().listName).toBe('neonwave');
    expect(player().list.map((t) => t.id)).toEqual([2]);
  });

  test('reflects the player, and toggles it rather than restarting when the song is current', async () => {
    await render();
    await page.getByRole('button', { name: 'Play Midnight Arcade' }).click();
    const playbackId = player().playback?.playbackId;
    await expect.element(page.getByText(/^Playing /)).toBeInTheDocument();

    await page.getByRole('button', { name: 'Pause Midnight Arcade' }).click();
    expect(player().playing).toBe(false);
    await expect.element(page.getByText('Paused')).toBeInTheDocument();

    await page.getByRole('button', { name: 'Play Midnight Arcade' }).click();
    expect(player().playing).toBe(true);
    expect(player().playback?.playbackId).toBe(playbackId);
  });

  test('shows the placeholder cover and no play button or lyrics until the guard reveals it', async () => {
    await render(false);
    await expect
      .element(page.getByRole('heading', { name: 'Midnight Arcade' }))
      .toBeInTheDocument();
    await expect.element(page.getByTestId('music-cover-placeholder')).toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Play Midnight Arcade' }))
      .not.toBeInTheDocument();
    await expect.element(lyricsBox()).not.toBeInTheDocument();
    expect(lyrics.queried.every((q) => q.enabled === false)).toBe(true);
  });
});

describe('synced lyrics', () => {
  test('highlight the line the playhead has reached while this song plays', async () => {
    await render();
    await expect.element(line('Coins in the slot')).not.toHaveAttribute('aria-current');

    await page.getByRole('button', { name: 'Play Midnight Arcade' }).click();
    useMusicPlayheadStore.setState({ currentTime: 5.5 });
    await expect.element(line('Every high score')).toHaveAttribute('aria-current', 'true');
    await expect.element(line('Coins in the slot')).not.toHaveAttribute('aria-current');

    useMusicPlayheadStore.setState({ currentTime: 9 });
    await expect.element(line('Joystick heartbeat')).toHaveAttribute('aria-current', 'true');
    await expect.element(line('Every high score')).not.toHaveAttribute('aria-current');
  });

  test('do not follow the playhead of another song', async () => {
    player().playTrack({
      id: 99,
      url: 'other',
      title: 'Other',
      durationSec: 100,
      creator: { id: 1, username: 'x' },
    });
    useMusicPlayheadStore.setState({ currentTime: 6 });
    await render();
    await expect.element(line('Every high score')).toBeInTheDocument();
    expect(document.querySelector('[aria-current]')).toBeNull();
  });

  test('a click on a line seeks the current song there and keeps it playing', async () => {
    await render();
    await page.getByRole('button', { name: 'Play Midnight Arcade' }).click();
    player().pause();

    await line('Joystick heartbeat').click();
    expect(seek).toHaveBeenCalledWith(9);
    expect(seekedSongs).toEqual([1]);
    expect(player().playing).toBe(true);
    expect(player().current?.id).toBe(1);
  });

  test('a click on a line while another song plays starts this one at the line, never seeking the other', async () => {
    player().playTrack({
      id: 99,
      url: 'other',
      title: 'Other',
      durationSec: 100,
      creator: { id: 1, username: 'x' },
    });
    await render();

    await line('Every high score').click();
    expect(player().current?.id).toBe(1);
    expect(player().playing).toBe(true);
    expect(player().playback?.startAtSec).toBe(5);
    expect(player().list.map((t) => t.id)).toEqual([2]);
    expect(seekedSongs.filter((id) => id !== 1)).toEqual([]);
  });

  test('a line without a time renders as text: no button, no seek', async () => {
    await render();
    await expect.element(lyricsBox().getByText('hums in blue')).toBeInTheDocument();
    await expect.element(line('hums in blue')).not.toBeInTheDocument();
    // The section label is a label, not a line.
    await expect.element(lyricsBox().getByText('[Verse 1]')).toBeInTheDocument();
    await expect.element(line('[Verse 1]')).not.toBeInTheDocument();
  });
});

describe('lyrics without times', () => {
  test('show as plain text: nothing to click and no highlight', async () => {
    lyrics.lines = [
      { t: null, text: 'Umbrellas bloom across the crossing' },
      { t: null, text: 'Neon melts in every puddle' },
    ];
    await render();
    await page.getByRole('button', { name: 'Play Midnight Arcade' }).click();
    useMusicPlayheadStore.setState({ currentTime: 30 });

    await expect.element(lyricsBox().getByText('Neon melts in every puddle')).toBeInTheDocument();
    expect(lyricsBox().element().querySelectorAll('button')).toHaveLength(0);
    expect(document.querySelector('[aria-current]')).toBeNull();
  });
});

test('a song with no lyrics shows the instrumental stage', async () => {
  lyrics.lines = null;
  await render();
  await expect.element(page.getByText('No lyrics on this one.')).toBeInTheDocument();
  await expect.element(lyricsBox()).not.toBeInTheDocument();
});

test('lyrics still loading show placeholder lines, not the instrumental card', async () => {
  lyrics.status = 'loading';
  await render();
  await expect.element(page.getByRole('status', { name: 'Loading lyrics' })).toBeInTheDocument();
  await expect.element(page.getByText('No lyrics on this one.')).not.toBeInTheDocument();
});

test('lyrics that failed to load say so, and do not claim the song is instrumental', async () => {
  lyrics.status = 'error';
  await render();
  await expect.element(page.getByText("Lyrics couldn't load.")).toBeInTheDocument();
  await expect.element(page.getByText('No lyrics on this one.')).not.toBeInTheDocument();
  await expect.element(lyricsBox()).not.toBeInTheDocument();
});
