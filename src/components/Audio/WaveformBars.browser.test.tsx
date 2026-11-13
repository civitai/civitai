// The real cascade (layer order first, as `_document.tsx` declares it): the bars and the
// slider take their size from Tailwind classes.
import '../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { WaveformBars } from '~/components/Audio/WaveformBars';

const bars = () => page.getByTestId('waveform-bar').elements() as HTMLElement[];

describe('the waveform bars', () => {
  test('draw one bar per peak, taller for louder peaks', async () => {
    renderWithProviders(
      <div style={{ width: 200, height: 40 }}>
        <WaveformBars peaks={[0.2, 1, 0.5]} progress={0} />
      </div>
    );
    await expect.element(page.getByTestId('waveform-bar').first()).toBeInTheDocument();
    const heights = bars().map((bar) => bar.getBoundingClientRect().height);
    expect(heights).toHaveLength(3);
    expect(heights[1]).toBeGreaterThan(heights[2]);
    expect(heights[2]).toBeGreaterThan(heights[0]);
  });

  test('mark the bars before the played fraction as played', async () => {
    const { rerender } = await renderWithProviders(
      <WaveformBars peaks={new Array(10).fill(0.5)} progress={0.3} />
    );
    await expect.element(page.getByTestId('waveform-bar').first()).toBeInTheDocument();
    const played = () => bars().map((bar) => bar.dataset.played === 'true');
    expect(played()).toEqual([true, true, true, false, false, false, false, false, false, false]);

    await rerender(<WaveformBars peaks={new Array(10).fill(0.5)} progress={1} />);
    expect(played().every(Boolean)).toBe(true);
  });

  test('paint played bars in the Civitai primary unless an enclosing player sets its own colour', async () => {
    await renderWithProviders(
      <div>
        <div data-testid="plain">
          <WaveformBars peaks={[0.5, 0.5]} progress={1} />
        </div>
        <div data-testid="tinted" style={{ ['--waveform-played' as string]: 'rgb(230, 73, 128)' }}>
          <WaveformBars peaks={[0.5, 0.5]} progress={1} />
        </div>
      </div>
    );
    await expect.element(page.getByTestId('waveform-bar').first()).toBeInTheDocument();
    const fill = (wrapper: string) =>
      getComputedStyle(
        page.getByTestId(wrapper).element().querySelector('[data-testid="waveform-bar"]')!
      ).backgroundColor;
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--mantine-primary-color-filled)';
    document.body.appendChild(probe);
    const primary = getComputedStyle(probe).backgroundColor;
    probe.remove();

    expect(primary).not.toBe('rgba(0, 0, 0, 0)');
    expect(fill('plain')).toBe(primary);
    expect(fill('tinted')).toBe('rgb(230, 73, 128)');
  });
});
