// The real cascade (layer order first, as `_document.tsx` declares it): the scrub bar takes its
// size from Tailwind classes.
import '../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { GeneratedAudioOutput } from '~/components/ImageGeneration/GeneratedAudioOutput';
import type { AudioBlob } from '~/shared/orchestrator/workflow-data';

const audioOutput = (duration?: number) =>
  ({
    type: 'audio',
    url: 'https://example.test/song.mp3',
    duration,
    workflow: { metadata: { params: { title: 'Night drive' } } },
  } as unknown as AudioBlob);

// The output fills its card; give it one.
const renderOutput = (image: AudioBlob) =>
  renderWithProviders(
    <div style={{ width: 400, height: 400 }}>
      <GeneratedAudioOutput image={image} />
    </div>
  );

const audio = () => document.querySelector('audio') as HTMLAudioElement;
const slider = () => page.getByRole('slider', { name: 'Audio progress' });

// No audio is loaded in the test browser: the stubs flip `paused` and fire the events the element
// would.
function stubPlayback() {
  const setPaused = (media: HTMLMediaElement, paused: boolean) => {
    Object.defineProperty(media, 'paused', { configurable: true, value: paused });
    media.dispatchEvent(new Event(paused ? 'pause' : 'play'));
  };
  const play = vi
    .spyOn(HTMLMediaElement.prototype, 'play')
    .mockImplementation(function (this: HTMLMediaElement) {
      setPaused(this, false);
      return Promise.resolve();
    });
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, 'pause')
    .mockImplementation(function (this: HTMLMediaElement) {
      setPaused(this, true);
    });
  return {
    play,
    pause,
    restore: () => {
      play.mockRestore();
      pause.mockRestore();
    },
  };
}

describe('the generator audio output', () => {
  test('play starts the song and turns the button into Pause, and back', async () => {
    const stub = stubPlayback();
    try {
      await renderOutput(audioOutput(192));
      await expect.element(page.getByText('Night drive')).toBeVisible();

      await userEvent.click(page.getByRole('button', { name: 'Play' }));
      expect(stub.play).toHaveBeenCalledTimes(1);
      await expect.element(page.getByRole('button', { name: 'Pause' })).toBeVisible();

      await userEvent.click(page.getByRole('button', { name: 'Pause' }));
      expect(stub.pause).toHaveBeenCalledTimes(1);
      await expect.element(page.getByRole('button', { name: 'Play' })).toBeVisible();
    } finally {
      stub.restore();
    }
  });

  test('mute silences the song and turns the button into Unmute, and back', async () => {
    await renderOutput(audioOutput(192));

    await userEvent.click(page.getByRole('button', { name: 'Mute' }));
    expect(audio().muted).toBe(true);
    await expect.element(page.getByRole('button', { name: 'Unmute' })).toBeVisible();

    await userEvent.click(page.getByRole('button', { name: 'Unmute' }));
    expect(audio().muted).toBe(false);
    await expect.element(page.getByRole('button', { name: 'Mute' })).toBeVisible();
  });

  test('clicking the progress bar seeks the song there', async () => {
    await renderOutput(audioOutput(200));
    const box = slider().element().getBoundingClientRect();
    await userEvent.click(slider(), { position: { x: box.width * 0.25, y: box.height / 2 } });
    // A click lands on a pixel, not on an exact second.
    await expect
      .poll(() => Number(slider().element().getAttribute('aria-valuenow')))
      .toBeCloseTo(50, 0);
    expect(audio().currentTime).toBeCloseTo(50, 0);
  });

  test('takes the length from the loaded file when the output has none', async () => {
    await renderOutput(audioOutput());
    await expect.element(page.getByText('0:00')).toBeVisible();

    Object.defineProperty(audio(), 'duration', { configurable: true, value: 75 });
    audio().dispatchEvent(new Event('loadedmetadata'));

    await expect.element(page.getByText('1:15')).toBeVisible();
    await expect.element(slider()).toHaveAttribute('aria-valuemax', '75');
  });
});
