// The real cascade (layer order first, as `_document.tsx` declares it): the bars and the
// slider take their size from Tailwind classes.
import '../../../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';

const mocks = vi.hoisted(() => ({ peaks: null as number[] | null }));

vi.mock('~/components/Audio/useAudioPeaks', () => ({ useAudioPeaks: () => mocks.peaks }));

// eslint-disable-next-line import/first
import { SongPreviewPlayer } from '~/components/Post/EditV2/PostImageCards/SongPreviewPlayer';

const slider = () => page.getByRole('slider', { name: 'Song progress' });
const playedBars = () =>
  (page.getByTestId('waveform-bar').elements() as HTMLElement[]).filter(
    (bar) => bar.dataset.played === 'true'
  ).length;

describe('the song card player', () => {
  beforeEach(() => {
    mocks.peaks = null;
  });

  test('draws the waveform from the song peaks, with play and the duration', async () => {
    mocks.peaks = new Array(20).fill(0.5);
    await renderWithProviders(<SongPreviewPlayer src="song-key" duration={192} />);
    await expect.element(page.getByRole('button', { name: 'Play' })).toBeVisible();
    await expect.element(page.getByText('3:12')).toBeVisible();
    expect(page.getByTestId('waveform-bar').elements()).toHaveLength(20);
    expect(playedBars()).toBe(0);
  });

  test('clicking the waveform seeks there and colours the played part', async () => {
    mocks.peaks = new Array(20).fill(0.5);
    await renderWithProviders(
      <div style={{ width: 400 }}>
        <SongPreviewPlayer src="song-key" duration={200} />
      </div>
    );
    const box = slider().element().getBoundingClientRect();
    await userEvent.click(slider(), {
      position: { x: box.width * 0.75, y: box.height / 2 },
    });
    await expect.element(slider()).toHaveAttribute('aria-valuenow', '150');
    expect(playedBars()).toBe(15);
  });

  test('the arrow keys seek by five seconds', async () => {
    await renderWithProviders(<SongPreviewPlayer src="song-key" duration={200} />);
    slider().element().focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect.element(slider()).toHaveAttribute('aria-valuenow', '5');
  });

  test('play starts the song and turns the button into Pause, and back', async () => {
    // No audio is loaded in the test browser: the stubs flip `paused` and fire the events the
    // element would.
    const setPaused = (audio: HTMLMediaElement, paused: boolean) => {
      Object.defineProperty(audio, 'paused', { configurable: true, value: paused });
      audio.dispatchEvent(new Event(paused ? 'pause' : 'play'));
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
    try {
      await renderWithProviders(<SongPreviewPlayer src="song-key" duration={192} />);

      await userEvent.click(page.getByRole('button', { name: 'Play' }));
      expect(play).toHaveBeenCalledTimes(1);
      await expect.element(page.getByRole('button', { name: 'Pause' })).toBeVisible();

      await userEvent.click(page.getByRole('button', { name: 'Pause' }));
      expect(pause).toHaveBeenCalledTimes(1);
      await expect.element(page.getByRole('button', { name: 'Play' })).toBeVisible();
    } finally {
      play.mockRestore();
      pause.mockRestore();
    }
  });

  test('seeking stops at the start and at the end of the song', async () => {
    await renderWithProviders(<SongPreviewPlayer src="song-key" duration={12} />);
    slider().element().focus();

    await userEvent.keyboard('{ArrowLeft}');
    await expect.element(slider()).toHaveAttribute('aria-valuenow', '0');

    await userEvent.keyboard('{ArrowRight}');
    await expect.element(slider()).toHaveAttribute('aria-valuenow', '5');
    await userEvent.keyboard('{ArrowRight}');
    await expect.element(slider()).toHaveAttribute('aria-valuenow', '10');
    await userEvent.keyboard('{ArrowRight}');
    await expect.element(slider()).toHaveAttribute('aria-valuenow', '12');
    await userEvent.keyboard('{ArrowRight}');
    await expect.element(slider()).toHaveAttribute('aria-valuenow', '12');
  });

  test('without peaks the player keeps a plain progress bar and shows no error', async () => {
    await renderWithProviders(<SongPreviewPlayer src="song-key" duration={192} />);
    await expect.element(slider()).toBeVisible();
    expect(page.getByTestId('waveform-bar').elements()).toHaveLength(0);
    await expect.element(page.getByTestId('song-progress-fill')).toBeInTheDocument();
    expect(page.getByRole('alert').elements()).toHaveLength(0);
  });
});
