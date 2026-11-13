import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { MusicPlayerAudio, seekMusicPlayer } from '~/components/MusicPlayer/MusicPlayerAudio';
import { SongPreviewPlayer } from '~/components/Post/EditV2/PostImageCards/SongPreviewPlayer';
import type { MusicTrack } from '~/store/music-player.store';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';

// A tenth of a second of silence the browser can load: a URL it cannot reach would fire a real
// `error` part way through a test.
function silentWav() {
  const samples = 800;
  const view = new DataView(new ArrayBuffer(44 + samples));
  const text = (offset: number, value: string) =>
    [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) view.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([view.buffer], { type: 'audio/wav' }));
}
const urls = new Map<number, string>();
const urlFor = (id: number) => {
  if (!urls.has(id)) urls.set(id, silentWav());
  return urls.get(id) as string;
};

const track = (id: number): MusicTrack => ({
  id,
  url: urlFor(id),
  title: `Song ${id}`,
  durationSec: 200,
  creator: { id: 100 + id, username: `artist${id}` },
});

const player = () => useMusicPlayerStore.getState();
const audios = () => Array.from(document.querySelectorAll('audio'));
const audio = () => audios()[0];

const setTime = (media: HTMLMediaElement, time: number) => {
  Object.defineProperty(media, 'currentTime', { configurable: true, writable: true, value: time });
  media.dispatchEvent(new Event('timeupdate'));
};

// No audio is loaded in the test browser: the stubs flip `paused` and fire the events the element
// would.
let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  const setPaused = (media: HTMLMediaElement, paused: boolean) => {
    Object.defineProperty(media, 'paused', { configurable: true, value: paused });
    media.dispatchEvent(new Event(paused ? 'pause' : 'play'));
  };
  play = vi
    .spyOn(HTMLMediaElement.prototype, 'play')
    .mockImplementation(function (this: HTMLMediaElement) {
      setPaused(this, false);
      return Promise.resolve();
    });
  pause = vi
    .spyOn(HTMLMediaElement.prototype, 'pause')
    .mockImplementation(function (this: HTMLMediaElement) {
      setPaused(this, true);
    });
});
afterEach(() => {
  player().close();
  play.mockRestore();
  pause.mockRestore();
});

describe('the global player audio element', () => {
  test('one element keeps playing, at its position, while the page around it changes', async () => {
    const Layout = ({ page: content }: { page: string }) => (
      <div>
        <main>{content}</main>
        <MusicPlayerAudio />
      </div>
    );
    const { rerender } = await renderWithProviders(<Layout page="Post page" />);
    const element = audio();

    player().playTrack(track(1));
    setTime(element, 42);

    await rerender(<Layout page="Model page" />);
    await expect.element(page.getByText('Model page')).toBeVisible();
    expect(audios()).toHaveLength(1);
    expect(audio()).toBe(element);
    expect(audio().currentTime).toBe(42);
    expect(audio().paused).toBe(false);
    expect(useMusicPlayheadStore.getState().currentTime).toBe(42);
  });

  test('starts the song inside the action that asked for it, and follows pause and resume', async () => {
    await renderWithProviders(<MusicPlayerAudio />);
    // Nothing plays until someone asks.
    expect(play).not.toHaveBeenCalled();

    player().playTrack(track(1));
    // Synchronously, so the play() call stays inside the click that started it.
    expect(play).toHaveBeenCalledTimes(1);
    expect(audio().getAttribute('src')).toBe(track(1).url);

    player().pause();
    expect(audio().paused).toBe(true);
    player().resume();
    expect(audio().paused).toBe(false);
  });

  test('when a song ends the next one in Up next plays', async () => {
    await renderWithProviders(<MusicPlayerAudio />);
    player().playTrack(track(1), { list: { name: 'Post', tracks: [track(1), track(2)] } });

    audio().dispatchEvent(new Event('ended'));

    expect(player().current?.id).toBe(2);
    expect(audio().getAttribute('src')).toBe(track(2).url);
    expect(audio().paused).toBe(false);
  });

  test('a restart of the same song goes back to 0:00', async () => {
    await renderWithProviders(<MusicPlayerAudio />);
    player().playTrack(track(1));
    setTime(audio(), 90);

    player().previous();

    expect(audio().currentTime).toBe(0);
    expect(useMusicPlayheadStore.getState().currentTime).toBe(0);
  });

  test('a song that fails to load leaves the player not playing, without throwing', async () => {
    await renderWithProviders(<MusicPlayerAudio />);
    player().playTrack(track(1));

    audio().dispatchEvent(new Event('error'));

    expect(player().error).toBe(true);
    expect(player().playing).toBe(false);
    expect(player().current?.title).toBe('Song 1');
  });

  test('a play the browser refuses leaves the player paused', async () => {
    play.mockImplementation(() =>
      Promise.reject(new DOMException('No user gesture', 'NotAllowedError'))
    );
    await renderWithProviders(<MusicPlayerAudio />);
    player().playTrack(track(1));
    await expect.poll(() => player().playing).toBe(false);
    expect(player().error).toBe(false);
  });

  test('takes the length, volume and mute to and from the element', async () => {
    await renderWithProviders(<MusicPlayerAudio />);
    player().playTrack(track(1));

    Object.defineProperty(audio(), 'duration', { configurable: true, value: 187.5 });
    audio().dispatchEvent(new Event('loadedmetadata'));
    expect(player().playback?.durationSec).toBe(187.5);
    expect(useMusicPlayheadStore.getState().duration).toBe(187.5);

    player().setVolume(0.4);
    player().toggleMute();
    expect(audio().volume).toBeCloseTo(0.4);
    expect(audio().muted).toBe(true);

    seekMusicPlayer(500);
    expect(audio().currentTime).toBe(187.5);
  });

  test('close stops the audio and unloads the song', async () => {
    await renderWithProviders(<MusicPlayerAudio />);
    player().playTrack(track(1));
    player().close();
    expect(audio().paused).toBe(true);
    expect(audio().hasAttribute('src')).toBe(false);
  });

  test('a component that does not show the time does not re-render as the song plays', async () => {
    let titleRenders = 0;
    function Title() {
      titleRenders++;
      const title = useMusicPlayerStore((s) => s.current?.title);
      return <span>{title}</span>;
    }
    function Elapsed() {
      const time = useMusicPlayheadStore((s) => s.currentTime);
      return <span data-testid="elapsed">{time}</span>;
    }
    function Toggle() {
      const [shown, setShown] = useState(true);
      return (
        <button type="button" onClick={() => setShown(!shown)}>
          {shown ? <Title /> : 'hidden'}
        </button>
      );
    }
    await renderWithProviders(
      <>
        <Toggle />
        <Elapsed />
        <MusicPlayerAudio />
      </>
    );
    player().playTrack(track(1));
    await expect.element(page.getByText('Song 1')).toBeVisible();
    const before = titleRenders;

    for (let t = 1; t <= 5; t++) setTime(audio(), t);

    await expect.element(page.getByTestId('elapsed')).toHaveTextContent('5');
    expect(titleRenders).toBe(before);
    // The title component is live: it re-renders when what it shows changes.
    await userEvent.click(page.getByRole('button'));
    await expect.element(page.getByText('hidden')).toBeVisible();
  });

  test('one sound at a time: the global player and a song preview pause each other', async () => {
    await renderWithProviders(
      <>
        <MusicPlayerAudio />
        <SongPreviewPlayer src={urlFor(9)} duration={10} />
      </>
    );
    const preview = (name: string) => page.getByRole('button', { name, exact: true });

    await preview('Play').click();
    await expect.element(preview('Pause')).toBeInTheDocument();

    act(() => player().playTrack(track(1)));
    expect(player().playing).toBe(true);
    await expect.element(preview('Play')).toBeInTheDocument();

    await preview('Play').click();
    await expect.element(preview('Pause')).toBeInTheDocument();
    expect(player().playing).toBe(false);
  });
});
