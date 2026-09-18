import { describe, expect, it } from 'vitest';
import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import {
  addTagToHubGroup,
  groupHubSources,
  excludeGroupRule,
  groupAddHint,
  nextHubGroupKey,
  removeHubGroup,
  setHubGroupEnabled,
  removeHubTag,
} from '~/components/Hubs/hub.utils';
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

const groupOf = (value: HubSourceValue[], index = 0) => groupHubSources(value)[index];

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

    expect(groups.map((group) => group.sources.map((s) => s.targetId))).toEqual([[10], [11]]);
  });

  it('keeps an include group and an exclude group with the SAME key apart', () => {
    // 🔴 Mirrors the polarity scoping in resolveHubSources, via the shared
    // `hubTagGroupKey`. Merging them would draw a kept-out tag as a member of the hub's
    // own AND-set, and removing the card would then delete a source on the other side.
    const groups = groupHubSources([
      source({ targetId: 77, groupKey: 0 }),
      source({ targetId: 90, groupKey: 0, exclude: true }),
    ]);

    expect(groups.map((group) => group.sources.map((s) => s.targetId))).toEqual([[77], [90]]);
  });
});

describe('nextHubGroupKey', () => {
  it('returns the LOWEST key no source holds', () => {
    // Lowest-free, not max-plus-one: the key is bounded by how many rows a hub may
    // hold, which is what `userHubSourceSchema`'s `.max()` is set to. Max-plus-one
    // climbs past that across enough edits and refuses a save nobody can fix.
    expect(nextHubGroupKey([{ groupKey: 0 }, { groupKey: 3 }, { groupKey: null }])).toBe(1);
  });

  it('starts at 0 on a hub that has never grouped anything', () => {
    // 0 is a real key, not a falsy placeholder — `first.groupKey ?? nextHubGroupKey`
    // in `addTagToHubGroup` relies on it surviving `??`, which `||` would swallow.
    expect(nextHubGroupKey([{ groupKey: null }, {}])).toBe(0);
  });
});

describe('addTagToHubGroup', () => {
  it('mints a key on the click that creates the group, and puts BOTH tags in it', () => {
    const value = [source({ targetId: 77 })];
    const next = addTagToHubGroup(value, groupOf(value), { targetId: 78, alias: 'cyberpunk' });

    expect(next.map((s) => [s.targetId, s.groupKey])).toEqual([
      [77, 0],
      [78, 0],
    ]);
  });

  it('reuses the key when the card is ALREADY a group', () => {
    const value = [source({ targetId: 77, groupKey: 4 }), source({ targetId: 78, groupKey: 4 })];
    const next = addTagToHubGroup(value, groupOf(value), { targetId: 79, alias: 'forest' });

    expect(next.map((s) => s.groupKey)).toEqual([4, 4, 4]);
  });

  it('🔴 gives a tag added to a KEPT-OUT group the exclude side', () => {
    // Defaulting `exclude` to false lands the new tag on the INCLUDE side, where the
    // polarity scoping splits it into its own card — so a click meaning "block more"
    // adds a source that SURFACES content, and the card it came from looks unchanged.
    const value = [source({ targetId: 90, exclude: true })];
    const next = addTagToHubGroup(value, groupOf(value), { targetId: 91, alias: 'violence' });

    expect(next.map((s) => s.exclude)).toEqual([true, true]);
  });

  it('gives a tag joining a switched-OFF group the same off state', () => {
    // A group toggles as one. Arriving enabled would leave the card reading off while
    // one of its tags still filters the feed.
    const value = [source({ targetId: 77, enabled: false })];
    const next = addTagToHubGroup(value, groupOf(value), { targetId: 78, alias: 'cyberpunk' });

    expect(next.map((s) => s.enabled)).toEqual([false, false]);
  });

  it('🔴 REFUSES to move a kept-out tag into an include group', () => {
    // The refusal lives in the caller too, where the message is shown — but the caller
    // is component code with no suite, so this is the half that can be tested. Without
    // it, the move branch does not rewrite `exclude`: the row keeps `exclude: true` and
    // takes the include group's key, landing it in the server's EXCLUDE bucket and
    // merging it into an unrelated AND-set. `NOT (a AND b)` removes strictly less than
    // `NOT a OR NOT b`, so an exclusion the owner set quietly stops excluding.
    const value = [source({ targetId: 77 }), source({ targetId: 90, exclude: true, index: 1 })];
    const next = addTagToHubGroup(value, groupOf(value), { targetId: 90, alias: 'violence' });

    // The literal rows, not `toEqual(value)`: the refusal returns `value` itself, so
    // comparing against it is a value compared with itself and would survive a future
    // edit that mutated rows in place instead of mapping to new ones.
    expect(next[1].exclude).toBe(true);
    expect(next[1].groupKey).toBeNull();
    expect(next.map((s) => [s.targetId, s.groupKey])).toEqual([
      [77, null],
      [90, null],
    ]);
  });

  it('MOVES a tag the hub already holds, keeping everything but its group', () => {
    // `(hubId, type, targetId)` is unique, so there is only ever one row per tag.
    // Refusing this left an owner unable to group two tags they already had: the picker
    // showed the second greyed out as "Added", with no way forward.
    //
    // The whole row is asserted, against a fixture that differs from the group on
    // `alias`, `enabled`, `index` and `groupKey` — a moved row keeps its own `alias`
    // and `index`, and takes the group's key AND its enabled state.
    //
    // ⚠️ It does NOT cover `exclude`, and cannot: the move is refused outright when the
    // polarities differ (the case above), so by the time this branch runs the two are
    // already equal and rewriting `exclude` here is unobservable. Measured — adding
    // `exclude: !!first.exclude` to the move branch leaves this file green. If the
    // refusal is ever relaxed, this stops being a no-op and needs its own case.
    const value = [
      source({ targetId: 77, enabled: false, groupKey: 2 }),
      source({ targetId: 78, alias: 'cyberpunk', enabled: true, index: 5 }),
    ];
    const next = addTagToHubGroup(value, groupOf(value), { targetId: 78, alias: 'ignored' });

    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({
      type: UserHubSourceType.Tag,
      targetId: 78,
      alias: 'cyberpunk',
      enabled: false,
      exclude: false,
      index: 5,
      groupKey: 2,
    });
  });

  it('leaves the group a moved tag came FROM coherent', () => {
    // The picker offers a tag that sits in another group, so a move can empty one. The
    // vacated group must keep its remaining member rather than losing its key with it.
    const value = [
      source({ targetId: 77, groupKey: 0 }),
      source({ targetId: 78, groupKey: 1, index: 1 }),
      source({ targetId: 79, groupKey: 1, index: 2 }),
    ];
    const next = addTagToHubGroup(value, groupOf(value), { targetId: 78, alias: 'cyberpunk' });

    expect(next.map((s) => [s.targetId, s.groupKey])).toEqual([
      [77, 0],
      [78, 0],
      [79, 1],
    ]);
  });
});

describe('group edits touch the whole group, or exactly one tag', () => {
  const value = [
    source({ targetId: 77, groupKey: 0 }),
    source({ targetId: 78, groupKey: 0 }),
    source({ targetId: 79, index: 2 }),
  ];

  it('removes ONE tag from the hub without taking its group with it', () => {
    // The chip ✕ and the card's trash are one click apart. Swapping them deletes the
    // whole AND-set, and the card simply vanishes — which reads exactly like the trash
    // button having been pressed.
    //
    // It deletes rather than ungroups. That was tried the other way and Justin called
    // it weird on sight: a ✕ that leaves the tag behind as a new card does not look
    // like a removal. The label matches. See `removeHubTag`.
    const next = removeHubTag(value, 78);

    expect(next.map((s) => s.targetId)).toEqual([77, 79]);
    expect(next.map((s) => s.groupKey)).toEqual([0, null]);
  });

  it('removes every member when the group itself is removed', () => {
    expect(removeHubGroup(value, groupOf(value)).map((s) => s.targetId)).toEqual([79]);
  });

  it('switches every member together, and nothing outside the group', () => {
    const next = setHubGroupEnabled(value, groupOf(value), false);

    expect(next.map((s) => [s.targetId, s.enabled])).toEqual([
      [77, false],
      [78, false],
      [79, true],
    ]);
  });
});

describe('the group copy', () => {
  it('🔴 says OPPOSITE things on the two sides, on purpose', () => {
    // Named for the decision, because the next competent review will correctly
    // recommend making these agree. Do not. Grouping tags you WANT narrows the feed;
    // grouping tags you want GONE removes less, because `NOT (x AND y)` keeps an image
    // carrying only x. Justin approved the asymmetry on 2026-09-17.
    //
    // The TOOLTIP is pinned rather than the rule line, because it is the copy that
    // renders on both sides. The rule line is exclude-only — an include-side string
    // would be pinned here and shown nowhere, which is a test guarding dead code.
    expect(groupAddHint(false)).toBe('Require another tag');
    expect(groupAddHint(true)).toBe('Only block when another tag matches too');
  });

  it('states the exclude rule under the chips, and has no include counterpart', () => {
    expect(excludeGroupRule).toBe('Only block when all of these match');
  });
});
