import { describe, expect, it } from 'vitest';
import { isViewerUsername } from '~/utils/is-viewer';

describe('isViewerUsername', () => {
  it.each([
    ['same username', { username: 'Alice' }, 'Alice', true],
    ['different case', { username: 'Alice' }, 'aLICE', true],
    ['other username', { username: 'Alice' }, 'Bob', false],
    ['signed out', null, 'Alice', false],
    ['viewer without a username', { username: null }, 'Alice', false],
    ['no username filter', { username: 'Alice' }, undefined, false],
    ['empty username filter', { username: '' }, '', false],
  ])('%s', (_, currentUser, username, expected) => {
    expect(isViewerUsername(currentUser, username)).toBe(expected);
  });
});
