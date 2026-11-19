import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { NamePlateText } from '~/components/User/NamePlateText';

const animated = {
  variant: 'gradient' as const,
  gradient: { from: '#ff4d6d', to: '#4cc9f0', deg: 90 },
  animated: true,
};

// A real IntersectionObserver in a real browser: the sweep repaints text every frame, so a plate
// the viewer cannot see must be marked for the CSS that pauses it.
const marked = (el: Element) => el.getAttribute('data-offscreen');

describe('animated nameplate sweep pauses off screen', () => {
  test('a plate below the fold is marked offscreen, and unmarked once scrolled into view', async () => {
    renderWithProviders(
      <div>
        <NamePlateText nameplate={animated} data-testid="top">
          Top
        </NamePlateText>
        <div style={{ height: 3000 }} />
        <NamePlateText nameplate={animated} data-testid="bottom">
          Bottom
        </NamePlateText>
      </div>
    );
    await expect.element(page.getByTestId('top')).toBeInTheDocument();
    const top = page.getByTestId('top').element();
    const bottom = page.getByTestId('bottom').element();

    await expect.poll(() => marked(top)).toBe('false');
    await expect.poll(() => marked(bottom)).toBe('true');

    bottom.scrollIntoView();
    await expect.poll(() => marked(bottom)).toBe('false');
    await expect.poll(() => marked(top)).toBe('true');
  });

  test('a static plate is never observed or marked', async () => {
    renderWithProviders(
      <NamePlateText nameplate={{ ...animated, animated: false }} data-testid="still">
        Still
      </NamePlateText>
    );
    await expect.element(page.getByTestId('still')).toBeInTheDocument();
    const el = page.getByTestId('still').element();
    await new Promise((r) => setTimeout(r, 200));
    expect(marked(el)).toBeNull();
  });
});
