import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { HeroBulbs } from '~/components/Events/ScoredEvent/HeroBulbs';

const colors = ['#ff4d6d', '#ffd166', '#06d6a0', '#4cc9f0'];

describe('HeroBulbs', () => {
  // A running animation forces a frame whether or not anyone can see it.
  test('is marked offscreen below the fold, and unmarked once scrolled into view', async () => {
    await renderWithProviders(
      <div>
        <div style={{ height: 3000 }} />
        <div style={{ position: 'relative', height: 40 }}>
          <HeroBulbs colors={colors} />
        </div>
      </div>
    );
    await expect.element(page.getByTestId('hero-bulbs')).toBeInTheDocument();
    const el = page.getByTestId('hero-bulbs').element();
    await expect.poll(() => el.getAttribute('data-offscreen')).toBe('true');
    const bulb = el.firstElementChild as HTMLElement;
    expect(getComputedStyle(bulb).animationPlayState).toBe('paused');
    el.scrollIntoView();
    await expect.poll(() => el.getAttribute('data-offscreen')).toBe('false');
    expect(getComputedStyle(bulb).animationPlayState).toBe('running');
  });

  // On a phone the odd-numbered children are hidden, so the bulbs that stay must still cycle
  // through every colour (four colours would otherwise leave only two).
  test('the bulbs kept on a phone still cycle through every colour', async () => {
    await renderWithProviders(<HeroBulbs colors={colors} count={22} />);
    await expect.element(page.getByTestId('hero-bulbs')).toBeInTheDocument();
    const spans = [...page.getByTestId('hero-bulbs').element().children] as HTMLElement[];
    const kept = spans.filter((_, i) => i % 2 === 0);
    expect(kept).toHaveLength(11);
    expect(new Set(kept.map((s) => s.style.getPropertyValue('--bulb-sm'))).size).toBe(4);
    // The full string keeps its colouring.
    expect(spans.map((s) => s.style.getPropertyValue('--bulb')).slice(0, 5)).toEqual([
      ...colors,
      colors[0],
    ]);
  });
});
