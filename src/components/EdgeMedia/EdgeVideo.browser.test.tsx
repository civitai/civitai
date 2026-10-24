import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';

const SRC = '00000001-0000-4000-8000-000000000000';

const hoverFor = (ms: number) => {
  const video = document.querySelector('video')!;
  video.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  vi.advanceTimersByTime(ms);
};

let play: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  play.mockRestore();
});

describe('EdgeVideo — hover to play', () => {
  test('plays after a second of hover by default', async () => {
    renderWithProviders(<EdgeVideo src={SRC} />);
    await vi.waitFor(() => expect(document.querySelector('video')).toBeTruthy());

    hoverFor(1_100);

    expect(play).toHaveBeenCalled();
  });

  test('never plays on hover with hoverPlay off', async () => {
    renderWithProviders(<EdgeVideo src={SRC} hoverPlay={false} />);
    await vi.waitFor(() => expect(document.querySelector('video')).toBeTruthy());

    hoverFor(1_100);

    expect(play).not.toHaveBeenCalled();
  });
});
