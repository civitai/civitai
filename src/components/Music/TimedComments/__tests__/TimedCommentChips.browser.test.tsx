import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as MusicPlayerAudio from '~/components/MusicPlayer/MusicPlayerAudio';
import type * as MoreFromCreator from '~/components/Music/SongDetail/useMoreFromCreator';

const moreFrom = vi.hoisted(() => ({ songs: [] as unknown[] }));
const seek = vi.hoisted(() => vi.fn());
const sent = vi.hoisted(() => vi.fn());

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

import {
  SongCommentsProvider,
  useSongTimeChoice,
} from '~/components/Music/TimedComments/SongCommentsContext';
import { CommentTimeChip, SongTimeChip } from '~/components/Music/TimedComments/TimedCommentChips';
import { songTrack } from '~/components/MusicPlayer/PostSong';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';

const song = (id: number, title: string) => ({
  id,
  url: `song-${id}.mp3`,
  metadata: { title, duration: 178 },
  user: { id: 7, username: 'neonwave' },
});
const midnight = song(1, 'Midnight Arcade');
const palm = song(2, 'Palm Static');
const player = () => useMusicPlayerStore.getState();

/** The composer's chip, and a Send that reports the time the comment would carry. */
function Composer({ durationSec = 178 }: { durationSec?: number }) {
  const choice = useSongTimeChoice({ songId: midnight.id, durationSec });
  return (
    <>
      <SongTimeChip choice={choice} />
      <button type="button" onClick={() => sent(choice.timestampSec())}>
        Send
      </button>
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  player().close();
  useMusicPlayheadStore.setState({ currentTime: 84.7, duration: 178 });
  moreFrom.songs = [palm];
});

describe('the composer’s time chip on a song', () => {
  test('is on while the song plays, and sends the playhead’s whole second', async () => {
    player().playTrack(songTrack(midnight));
    await renderWithProviders(<Composer />);
    const chip = page.getByRole('button', { name: 'at 1:24' });
    await expect.element(chip).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(page.getByRole('button', { name: 'Send' }));
    expect(sent).toHaveBeenLastCalledWith(84);
  });

  test('turned off, sends the comment without a time; turned back on, with one', async () => {
    player().playTrack(songTrack(midnight));
    await renderWithProviders(<Composer />);
    const chip = page.getByRole('button', { name: 'at 1:24' });
    await userEvent.click(chip);
    await expect.element(chip).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(page.getByRole('button', { name: 'Send' }));
    expect(sent).toHaveBeenLastCalledWith(undefined);
    await userEvent.click(chip);
    await userEvent.click(page.getByRole('button', { name: 'Send' }));
    expect(sent).toHaveBeenLastCalledWith(84);
  });

  test('never sends a time past the song’s stored length', async () => {
    player().playTrack(songTrack(midnight));
    // The audio element can run a little past the length the server stored for the song.
    useMusicPlayheadStore.setState({ currentTime: 178.9, duration: 179.4 });
    await renderWithProviders(<Composer />);
    await userEvent.click(page.getByRole('button', { name: 'Send' }));
    expect(sent).toHaveBeenLastCalledWith(178);
  });

  test('is off for a song without a stored length, so its comments still post', async () => {
    player().playTrack(songTrack(midnight));
    await renderWithProviders(<Composer durationSec={0} />);
    await expect.element(page.getByRole('button', { name: 'at a time' })).toBeDisabled();
    await userEvent.click(page.getByRole('button', { name: 'Send' }));
    expect(sent).toHaveBeenLastCalledWith(undefined);
  });

  test('is off and disabled while another song (or none) is playing', async () => {
    player().playTrack(songTrack(palm));
    await renderWithProviders(<Composer />);
    const chip = page.getByRole('button', { name: 'at a time' });
    await expect.element(chip).toBeDisabled();
    await expect.element(chip).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(page.getByRole('button', { name: 'Send' }));
    expect(sent).toHaveBeenLastCalledWith(undefined);
  });
});

describe('a timed comment’s time in the list', () => {
  const renderChip = () =>
    renderWithProviders(
      <SongCommentsProvider song={midnight}>
        <CommentTimeChip timestampSec={42} />
      </SongCommentsProvider>
    );

  test('seeks the song there when it is the current song, and plays it', async () => {
    player().playTrack(songTrack(midnight));
    player().pause();
    await renderChip();
    await userEvent.click(page.getByRole('button', { name: 'Play from 0:42' }));
    expect(seek).toHaveBeenCalledWith(42);
    expect(player().playing).toBe(true);
    expect(player().current?.id).toBe(midnight.id);
  });

  test('starts the song there otherwise, with the creator’s songs as Up next', async () => {
    player().playTrack(songTrack(palm));
    await renderChip();
    await userEvent.click(page.getByRole('button', { name: 'Play from 0:42' }));
    expect(seek).not.toHaveBeenCalled();
    expect(player().current?.id).toBe(midnight.id);
    expect(player().playback?.startAtSec).toBe(42);
    expect(player().list.map((t) => t.id)).toEqual([palm.id]);
    expect(player().listName).toBe('neonwave');
  });

  test('is not shown outside a song’s comments', async () => {
    await renderWithProviders(
      <>
        <CommentTimeChip timestampSec={42} />
        <span>end</span>
      </>
    );
    await expect.element(page.getByText('end')).toBeInTheDocument();
    expect(document.querySelector('[aria-label="Play from 0:42"]')).toBeNull();
  });
});
