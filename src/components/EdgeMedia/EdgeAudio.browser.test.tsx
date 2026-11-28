import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { EdgeAudio } from '~/components/EdgeMedia/EdgeAudio';
import { MusicPlayerAudio } from '~/components/MusicPlayer/MusicPlayerAudio';
import { useMusicPlayerStore } from '~/store/music-player.store';

// A tenth of a second of silence the browser can load: a URL it cannot reach fires a real `error`,
// which stops the global player on its own and would pass for the pause under test.
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
const SONG_URL = silentWav();
const CLIP_URL = silentWav();

const player = () => useMusicPlayerStore.getState();
const globalAudio = () => document.querySelector<HTMLAudioElement>('audio.hidden')!;
const clip = () => page.getByTestId('clip').element() as HTMLAudioElement;
const playSong = () =>
  act(() =>
    player().playTrack({
      id: 1,
      url: SONG_URL,
      title: 'Song 1',
      durationSec: 200,
      creator: { id: 101, username: 'artist1' },
    })
  );

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

describe('an EdgeAudio and the global player', () => {
  test('starting an EdgeAudio pauses the global player through its store', async () => {
    const onPlay = vi.fn();
    await renderWithProviders(
      <>
        <MusicPlayerAudio />
        <EdgeAudio src={CLIP_URL} data-testid="clip" onPlay={onPlay} />
      </>
    );
    playSong();
    expect(player().playing).toBe(true);
    expect(globalAudio().paused).toBe(false);

    act(() => void clip().play());

    expect(player().playing).toBe(false);
    expect(globalAudio().paused).toBe(true);
    expect(player().error).toBe(false);
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  test('starting the global player pauses a playing EdgeAudio', async () => {
    await renderWithProviders(
      <>
        <MusicPlayerAudio />
        <EdgeAudio src={CLIP_URL} data-testid="clip" />
      </>
    );
    act(() => void clip().play());
    expect(clip().paused).toBe(false);

    playSong();

    expect(player().playing).toBe(true);
    expect(clip().paused).toBe(true);
  });

  test('a play event that arrives after the EdgeAudio was stopped leaves the global player playing', async () => {
    await renderWithProviders(
      <>
        <MusicPlayerAudio />
        <EdgeAudio src={CLIP_URL} data-testid="clip" />
      </>
    );
    playSong();

    act(() => {
      Object.defineProperty(clip(), 'paused', { configurable: true, value: true });
      clip().dispatchEvent(new Event('play'));
    });

    expect(player().playing).toBe(true);
    expect(globalAudio().paused).toBe(false);
  });
});
