import { describe, expect, test } from 'vitest';
import { isLinkClick } from '~/components/TrackView/useTrackImpression';

/**
 * A feed click counts only when the nearest control the click landed in is a link, so a menu
 * button inside the card's link is not a click through, and neither is the card's caption.
 */
describe('isLinkClick', () => {
  test('a link, or plain content inside one, is a click through; a button inside it is not', () => {
    const card = document.createElement('div');
    card.innerHTML =
      '<a href="/models/5"><img alt="cover"><button type="button">menu</button></a><span>caption</span>';
    const q = (selector: string) => card.querySelector(selector);

    expect(isLinkClick(q('a'))).toBe(true);
    expect(isLinkClick(q('img'))).toBe(true);
    expect(isLinkClick(q('button'))).toBe(false);
    expect(isLinkClick(q('span'))).toBe(false);
    expect(isLinkClick(null)).toBe(false);
  });
});
