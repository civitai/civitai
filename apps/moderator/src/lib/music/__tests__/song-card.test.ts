import { describe, expect, it } from 'vitest';
import { isSong } from '../song-card';

/**
 * Which queue items `ImageQueueGrid`, Image lookup and Removed-appeals render as a song card (Music
 * T10). An image or video keeps its own tile, exactly as before; this app's suite cannot render a
 * component, so the decision is pinned here and the tile itself is checked in the browser.
 */
describe('isSong', () => {
  it('keeps an image or a video on its own tile, and renders only a song as a player', () => {
    expect(isSong({ type: 'image' })).toBe(false);
    expect(isSong({ type: 'video' })).toBe(false);
    expect(isSong({ type: null })).toBe(false);
    expect(isSong({})).toBe(false);
    expect(isSong({ type: 'audio' })).toBe(true);
  });
});
