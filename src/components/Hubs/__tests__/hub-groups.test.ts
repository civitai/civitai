import { describe, expect, it } from 'vitest';
import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import { groupHubSources, nextHubGroupKey } from '~/components/Hubs/hub.utils';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';

const source = (over: Partial<HubSourceValue> & Pick<HubSourceValue, 'targetId'>) =>
  ({
    type: UserHubSourceType.Tag,
    alias: null,
    enabled: true,
    exclude: false,
    index: 0,
    groupKey: null,
    ...over,
  } as HubSourceValue);

describe('groupHubSources', () => {
  it('folds tags sharing a groupKey into one card and leaves null keys alone', () => {
    const groups = groupHubSources([
      source({ targetId: 77, groupKey: 0 }),
      source({ targetId: 78, groupKey: 0 }),
      source({ targetId: 79 }),
    ]);

    expect(groups.map((group) => group.sources.map((s) => s.targetId))).toEqual([[77, 78], [79]]);
  });

  it('never groups a non-tag source, whatever key it carries', () => {
    // Only tags are ANDable — the resolver groups tag rows alone, so a key on a
    // creator row is inert there. A client that grouped them anyway would render one
    // card for two creators whose feed arms are still ORed.
    const groups = groupHubSources([
      source({ targetId: 10, type: UserHubSourceType.User, groupKey: 0 }),
      source({ targetId: 11, type: UserHubSourceType.User, groupKey: 0 }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it('keeps an include group and an exclude group with the SAME key apart', () => {
    // 🔴 Mirrors the polarity scoping in resolveHubSources. Merging them would draw a
    // kept-out tag as a member of the hub's own AND-set, and removing the card would
    // then delete a source on the other side of the list.
    const groups = groupHubSources([
      source({ targetId: 77, groupKey: 0 }),
      source({ targetId: 90, groupKey: 0, exclude: true }),
    ]);

    expect(groups.map((group) => group.sources.map((s) => s.targetId))).toEqual([[77], [90]]);
  });
});

describe('nextHubGroupKey', () => {
  it('returns a key no existing source holds', () => {
    expect(nextHubGroupKey([{ groupKey: 0 }, { groupKey: 3 }, { groupKey: null }])).toBe(4);
  });

  it('starts at 0 on a hub that has never grouped anything', () => {
    // 0 is a real key, not a falsy placeholder — `first.groupKey ?? nextHubGroupKey`
    // in the editor relies on it surviving `??`, which `||` would swallow.
    expect(nextHubGroupKey([{ groupKey: null }, {}])).toBe(0);
  });
});
