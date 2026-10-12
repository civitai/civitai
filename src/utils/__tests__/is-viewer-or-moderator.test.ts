import { describe, expect, it } from 'vitest';
import { isViewerOrModerator } from '~/utils/is-viewer';

describe('isViewerOrModerator', () => {
  it.each([
    ['owner', { id: 7 }, true],
    ['stranger', { id: 8 }, false],
    ['moderator', { id: 8, isModerator: true }, true],
    ['signed out', {}, false],
    ['null id', { id: null }, false],
  ])('%s', (_, viewer, expected) => {
    expect(isViewerOrModerator(viewer, 7)).toBe(expected);
  });
});
