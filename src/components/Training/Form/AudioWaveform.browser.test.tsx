import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { AudioWaveform } from '~/components/Training/Form/AudioWaveform';

// No audio loads in the test browser: the stubs flip `paused` and fire the events the element would.
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
  play.mockRestore();
  pause.mockRestore();
});

describe("the training form's audio player", () => {
  test('plays and pauses from its button, which follows the element', async () => {
    await renderWithProviders(<AudioWaveform src="blob:training-clip" />);

    await page.getByRole('button', { name: 'Play' }).click();
    expect(play).toHaveBeenCalledTimes(1);
    await expect.element(page.getByRole('button', { name: 'Pause' })).toBeInTheDocument();

    await page.getByRole('button', { name: 'Pause' }).click();
    expect(pause).toHaveBeenCalledTimes(1);
    await expect.element(page.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });
});
