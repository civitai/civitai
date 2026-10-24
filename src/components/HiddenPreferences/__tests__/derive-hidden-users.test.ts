import { describe, expect, it } from 'vitest';
import { deriveHiddenUsers } from '~/components/HiddenPreferences/HiddenPreferencesProvider';

const HIDDEN = 1;
const BLOCKED = 2;
const BLOCKED_BY = 3;
const data = {
  hiddenUsers: [{ id: HIDDEN }],
  blockedUsers: [{ id: BLOCKED }],
  blockedByUsers: [{ id: BLOCKED_BY }],
};

const ids = (map: Map<number, boolean>) => [...map.keys()].sort();

describe('deriveHiddenUsers', () => {
  it('a viewer hides their own hides and blocks in both directions', () => {
    const { hiddenUsers, blockRelations } = deriveHiddenUsers(data, false);
    expect(ids(hiddenUsers)).toEqual([HIDDEN, BLOCKED, BLOCKED_BY]);
    expect(ids(blockRelations)).toEqual([BLOCKED, BLOCKED_BY]);
  });

  it('a moderator is not subject to blocks', () => {
    const { hiddenUsers, blockRelations } = deriveHiddenUsers(data, true);
    expect(ids(hiddenUsers)).toEqual([HIDDEN]);
    expect(ids(blockRelations)).toEqual([]);
  });
});
