import { describe, expect, it } from 'vitest';
import {
  messageOf,
  plural,
  releaseScopeLabel,
  shiftedMessage,
  shiftLabel,
  unscheduledMessage,
} from '../messages';

describe('messageOf', () => {
  it('prefers an Error message, then a non-empty string, then the fallback', () => {
    expect(messageOf(new Error('nope'), 'fallback')).toBe('nope');
    expect(messageOf('plain', 'fallback')).toBe('plain');
    expect(messageOf(new Error(''), 'fallback')).toBe('fallback');
    expect(messageOf('', 'fallback')).toBe('fallback');
    expect(messageOf({ message: 'x' }, 'fallback')).toBe('fallback');
  });
});

describe('plural / shiftLabel', () => {
  it('pluralises everything but one', () => {
    expect(plural(1, 'post')).toBe('1 post');
    expect(plural(0, 'post')).toBe('0 posts');
    expect(plural(2, 'release post')).toBe('2 release posts');
  });

  it('labels whole days and falls back to minutes', () => {
    expect(shiftLabel(1440)).toBe('+1 day');
    expect(shiftLabel(-1440)).toBe('-1 day');
    expect(shiftLabel(7 * 1440)).toBe('+7 days');
    expect(shiftLabel(90)).toBe('+90 min');
    expect(shiftLabel(-30)).toBe('-30 min');
  });
});

describe('unscheduledMessage / shiftedMessage', () => {
  it('reports what moved and what a release held back', () => {
    expect(unscheduledMessage({ unscheduledIds: [1], skippedReleaseIds: [] })).toBe(
      '1 post moved to drafts.'
    );
    expect(unscheduledMessage({ unscheduledIds: [1, 2], skippedReleaseIds: [3] })).toBe(
      '2 posts moved to drafts. 1 release post not moved — they move with their model.'
    );
    expect(shiftedMessage({ moved: [{ id: 1 }], skippedReleaseIds: [] }, 1440)).toBe(
      '1 post shifted by +1 day.'
    );
    expect(shiftedMessage({ moved: [{ id: 1 }, { id: 2 }], skippedReleaseIds: [3, 4] }, -60)).toBe(
      '2 posts shifted by -60 min. 2 release posts not moved.'
    );
  });
});

describe('releaseScopeLabel', () => {
  it('names the scope a release move drags along', () => {
    expect(releaseScopeLabel('model')).toBe('the whole model release');
    expect(releaseScopeLabel('version')).toBe("this version's release");
  });
});
