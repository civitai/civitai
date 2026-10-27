import { describe, expect, it } from 'vitest';
import { decideAccess, parseTesterIds } from './access';

describe('parseTesterIds', () => {
  it('reads a comma-separated list, tolerating spaces and blanks', () => {
    expect(parseTesterIds(' 12, 34 ,,56 ')).toEqual(new Set([12, 34, 56]));
  });

  it('drops entries that are not positive integers', () => {
    expect(parseTesterIds('7,abc,0,-3,1.5')).toEqual(new Set([7]));
  });

  it('is empty when unset', () => {
    expect(parseTesterIds(undefined)).toEqual(new Set());
    expect(parseTesterIds('')).toEqual(new Set());
  });
});

describe('decideAccess', () => {
  const testers = new Set([42]);

  it('lets a moderator in', () => {
    expect(decideAccess({ id: 1, isModerator: true }, testers)).toBe('allow');
  });

  it('lets a listed tester in', () => {
    expect(decideAccess({ id: 42 }, testers)).toBe('allow');
  });

  it('closes the door on everyone else', () => {
    expect(decideAccess({ id: 43 }, testers)).toBe('closed');
    expect(decideAccess({ id: 43, isModerator: false }, testers)).toBe('closed');
  });

  it('never lets a non-moderator in on an empty tester list', () => {
    expect(decideAccess({ id: 42 }, new Set())).toBe('closed');
  });
});
