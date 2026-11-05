import { describe, expect, test } from 'vitest';
import { peekToggleCorner } from '~/components/Sticker/peek-toggle-corner';

describe('peekToggleCorner', () => {
  test('nothing pending keeps the top-right corner', () => {
    expect(peekToggleCorner([])).toBe('top-right');
  });

  test('a sticker near the top-right moves the toggle to the top-left', () => {
    expect(peekToggleCorner([{ x: 0.85, y: 0.1 }])).toBe('top-left');
  });

  test('a taken corner is skipped: a sticker at the top-right and a hat at the top-left', () => {
    expect(peekToggleCorner([{ x: 0.85, y: 0.1 }], ['top-left'])).toBe('bottom-right');
  });

  test('the crowded fallback keeps out of a taken corner too', () => {
    const everywhere = [
      { x: 0.9, y: 0.1 },
      { x: 0.1, y: 0.9 },
      { x: 0.9, y: 0.9 },
      { x: 0.35, y: 0.3 },
    ];
    expect(peekToggleCorner(everywhere)).toBe('top-left');
    expect(peekToggleCorner(everywhere, ['top-left'])).not.toBe('top-left');
  });

  test('with every corner crowded it takes the one farthest from its nearest sticker', () => {
    expect(
      peekToggleCorner([
        { x: 0.9, y: 0.1 },
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.3, y: 0.75 },
      ])
    ).toBe('bottom-left');
  });
});
