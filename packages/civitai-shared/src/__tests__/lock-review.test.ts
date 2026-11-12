import { describe, expect, it } from 'vitest';
import { requestableLocks } from '../lock-review';

describe('requestableLocks', () => {
  it.each(['poi', 'minor'])('offers the other locked settings while %s is locked off', (mark) => {
    expect(
      requestableLocks({
        lockedProperties: [mark, 'sfwOnly', 'nsfw', 'category'],
        poi: false,
        minor: false,
      })
    ).toEqual(['nsfw', 'sfwOnly', 'category']);
  });

  it('offers them with both poi and minor locked off', () => {
    expect(
      requestableLocks({ lockedProperties: ['poi', 'minor', 'nsfw'], poi: false, minor: false })
    ).toEqual(['nsfw']);
  });

  it('offers the other locked settings while poi and minor are locked but unset', () => {
    expect(requestableLocks({ lockedProperties: ['poi', 'minor', 'tags'] })).toEqual(['tags']);
    expect(
      requestableLocks({ lockedProperties: ['poi', 'minor', 'tags'], poi: null, minor: null })
    ).toEqual(['tags']);
  });

  it.each([{ poi: true }, { minor: true }])('offers nothing on a model marked %o', (mark) => {
    expect(
      requestableLocks({ lockedProperties: ['poi', 'minor', 'nsfw', 'tags'], ...mark })
    ).toEqual([]);
    expect(requestableLocks({ lockedProperties: ['nsfw', 'tags'], ...mark })).toEqual([]);
  });

  it('never offers poi or minor themselves', () => {
    expect(
      requestableLocks({ lockedProperties: ['poi', 'minor'], poi: false, minor: false })
    ).toEqual([]);
  });
});
