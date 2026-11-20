// The real cascade, for the chip's colours in each scheme.
import '../../../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

  describe('reads at WCAG AA on the comment card', () => {
    afterEach(() => document.documentElement.removeAttribute('data-mantine-color-scheme'));
    const rgb = (css: string) => css.match(/[\d.]+/g)!.map(Number);
    const lum = ([r, g, b]: number[]) =>
      [r, g, b]
        .map((c) => c / 255)
        .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    // The chip's tint over the card (Mantine Card: white, dark-6), as the eye sees it.
    const over = ([r, g, b, a = 1]: number[], card: number[]) =>
      [r, g, b].map((c, i) => c * a + card[i] * (1 - a));

    for (const [scheme, card] of [
      ['light', [255, 255, 255]],
      ['dark', [0x25, 0x26, 0x2b]],
    ] as const)
      for (const hovered of [false, true])
        test(`in ${scheme} mode${hovered ? ', hovered' : ''}`, async () => {
          await renderChip();
          // After the render: the provider sets the scheme on mount.
          document.documentElement.setAttribute('data-mantine-color-scheme', scheme);
          const locator = page.getByRole('button', { name: 'Play from 0:42' });
          // Hovering darkens the tint, so the text must read on that too. Unhovered, the pointer is
          // moved off: an earlier test's click can leave it resting on the chip.
          if (hovered) await userEvent.hover(locator);
          else await userEvent.unhover(locator);
          const chip = locator.element();
          // Polled: the button's colours transition after the scheme flips.
          const ratio = () => {
            const style = getComputedStyle(chip);
            const text = lum(rgb(style.color));
            const background = lum(over(rgb(style.backgroundColor), [...card]));
            return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
          };
          await expect.poll(ratio).toBeGreaterThanOrEqual(4.5);
        });

    // A highlighted comment tints the card behind the chip; an opaque chip keeps its own contrast.
    for (const scheme of ['light', 'dark'] as const)
      test(`whatever is behind it, in ${scheme} mode`, async () => {
        await renderChip();
        document.documentElement.setAttribute('data-mantine-color-scheme', scheme);
        const chip = page.getByRole('button', { name: 'Play from 0:42' }).element();
        // Polled: the button's colours transition after the scheme flips.
        const ratio = () => {
          const style = getComputedStyle(chip);
          const [, , , alpha = 1] = rgb(style.backgroundColor);
          if (alpha !== 1) return 0;
          const text = lum(rgb(style.color));
          const background = lum(rgb(style.backgroundColor));
          return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
        };
        await expect.poll(ratio).toBeGreaterThanOrEqual(4.5);
      });
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
