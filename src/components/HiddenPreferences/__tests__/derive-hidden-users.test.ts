import { describe, expect, it } from 'vitest';
import {
  deriveHiddenUsers,
  deriveModeratedHiddenImages,
} from '~/components/HiddenPreferences/HiddenPreferencesProvider';

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
    const { hiddenUsers, blockRelations, blockedByUsers } = deriveHiddenUsers(data, false);
    expect(ids(hiddenUsers)).toEqual([HIDDEN, BLOCKED, BLOCKED_BY]);
    expect(ids(blockRelations)).toEqual([BLOCKED, BLOCKED_BY]);
    // Only those who blocked the viewer: the one hide "Show anyway" may never set aside.
    expect(ids(blockedByUsers)).toEqual([BLOCKED_BY]);
  });

  it('a moderator is not subject to blocks', () => {
    const { hiddenUsers, blockRelations, blockedByUsers } = deriveHiddenUsers(data, true);
    expect(ids(hiddenUsers)).toEqual([HIDDEN]);
    expect(ids(blockRelations)).toEqual([]);
    expect(ids(blockedByUsers)).toEqual([]);
  });
});

describe('deriveModeratedHiddenImages', () => {
  const MATURE = 10; // moderated, hidden by the viewer
  const ORDINARY = 11; // hidden by the viewer, not moderated
  const MATURE_SHOWN = 12; // moderated, not hidden by the viewer
  const hiddenTags = new Map([
    [MATURE, true],
    [ORDINARY, true],
  ]);
  const moderatedTags = [{ id: MATURE }, { id: MATURE_SHOWN }];

  it('keeps only images hidden by a vote on a moderated tag the viewer hides', () => {
    const images = [
      { id: 1, tagId: MATURE },
      { id: 2, tagId: ORDINARY },
      { id: 3 },
      { id: 4, tagId: MATURE_SHOWN },
    ];
    expect(ids(deriveModeratedHiddenImages(images, hiddenTags, moderatedTags))).toEqual([1]);
  });
});
