import { describe, expect, it } from 'vitest';
import {
  assertDraftFitsRows,
  boxParamsForSave,
  BoxRefusal,
  keptContentIds,
  planContentWrites,
  planTierWrites,
  type BoxContentRow,
  type BoxTierRow,
  type DraftContent,
  type DraftTier,
} from '../box-builder';

const BOX = 9;
const savedTiers: BoxTierRow[] = [
  { id: 1, key: 'common', name: 'Common', weight: 80, color: null, sortOrder: 0 },
  { id: 2, key: 'rare', name: 'Rare', weight: 20, color: '#00f', sortOrder: 1 },
];
const savedContents: BoxContentRow[] = [
  { id: 10, rewardDefinitionId: 100, tierId: 1, enabled: true },
  { id: 11, rewardDefinitionId: 101, tierId: 2, enabled: true },
];
const asSaved = (): DraftTier[] =>
  savedTiers.map(({ id, key, name, weight, color }) => ({ id, key, name, weight, color }));
const contentsAsSaved = (): DraftContent[] => [
  { id: 10, rewardDefinitionId: 100, tierKey: 'common', enabled: true },
  { id: 11, rewardDefinitionId: 101, tierKey: 'rare', enabled: true },
];

describe('assertDraftFitsRows', () => {
  it('passes the box as saved', () => {
    expect(() =>
      assertDraftFitsRows(
        { tiers: asSaved(), contents: contentsAsSaved() },
        savedTiers,
        savedContents
      )
    ).not.toThrow();
  });

  it.each<[string, DraftTier[], DraftContent[], string]>([
    [
      'two tiers with one key',
      [...asSaved(), { id: null, key: 'rare', name: 'Rare 2', weight: 1, color: null }],
      contentsAsSaved(),
      'Two tiers share the key "rare".',
    ],
    [
      "a new tier reusing a saved tier's key",
      [asSaved()[0], { id: null, key: 'rare', name: 'Rare', weight: 1, color: null }],
      [],
      'The key "rare" is already used by a tier of this box.',
    ],
    [
      'a tier id from another box',
      [...asSaved(), { id: 99, key: 'epic', name: 'Epic', weight: 1, color: null }],
      contentsAsSaved(),
      "Tier #99 isn't in this box.",
    ],
    // The odds history names tiers by key, so a saved tier keeps its key.
    [
      'a saved tier renamed by key',
      [asSaved()[0], { ...asSaved()[1], key: 'epic' }],
      contentsAsSaved(),
      'Tier "rare" can\'t change its key once saved.',
    ],
    [
      'a content id from another box',
      asSaved(),
      [...contentsAsSaved(), { id: 99, rewardDefinitionId: 102, tierKey: 'rare', enabled: true }],
      "Content #99 isn't in this box.",
    ],
    [
      'one content listed twice',
      asSaved(),
      [...contentsAsSaved(), { id: 11, rewardDefinitionId: 101, tierKey: 'common', enabled: true }],
      'Content #11 is in the box twice.',
    ],
  ])('refuses %s', (_label, tiers, contents, message) => {
    const refuse = () => assertDraftFitsRows({ tiers, contents }, savedTiers, savedContents);
    // A BoxRefusal, not any Error: the action answers 409 only for that class.
    expect(refuse).toThrow(BoxRefusal);
    expect(refuse).toThrow(message);
  });
});

describe('planTierWrites', () => {
  it('writes nothing for the box as saved', () => {
    const plan = planTierWrites(BOX, { tiers: asSaved() }, savedTiers);
    expect(plan.newTiers).toEqual([]);
    expect(plan.changedTiers).toEqual([]);
    expect(plan.tierIdByKey.get('common')).toBe(1);
    expect(plan.tierIdByKey.get('rare')).toBe(2);
    expect(plan.tierIdByKey.size).toBe(2);
  });

  // Order held fixed, so each case changes only the field it names.
  it.each<[string, Partial<DraftTier>, Partial<BoxTierRow>]>([
    ['name', { name: 'Ultra' }, { name: 'Ultra' }],
    ['weight', { weight: 25 }, { weight: 25 }],
    ['colour', { color: '#f00' }, { color: '#f00' }],
  ])('updates a tier whose %s alone changed', (_label, change, written) => {
    const [common, rare] = asSaved();
    const plan = planTierWrites(BOX, { tiers: [common, { ...rare, ...change }] }, savedTiers);
    expect(plan.changedTiers).toEqual([
      { id: 2, name: 'Rare', weight: 20, color: '#00f', sortOrder: 1, ...written },
    ]);
  });

  it('inserts new tiers and updates only the changed ones, ordered by position', () => {
    const [common, rare] = asSaved();
    const plan = planTierWrites(
      BOX,
      {
        tiers: [
          { ...rare, weight: 30 },
          { id: null, key: 'epic', name: ' Epic ', weight: 5, color: null },
          common,
        ],
      },
      savedTiers
    );
    expect(plan.newTiers).toEqual([
      { boxDefinitionId: BOX, key: 'epic', name: 'Epic', weight: 5, color: null, sortOrder: 1 },
    ]);
    expect(plan.changedTiers).toEqual([
      { id: 2, name: 'Rare', weight: 30, color: '#00f', sortOrder: 0 },
      { id: 1, name: 'Common', weight: 80, color: null, sortOrder: 2 },
    ]);
  });
});

describe('planContentWrites', () => {
  const ids = new Map([
    ['common', 1],
    ['rare', 2],
  ]);

  it('inserts new contents and updates only the changed ones', () => {
    const plan = planContentWrites(
      BOX,
      {
        contents: [
          { id: 10, rewardDefinitionId: 100, tierKey: 'rare', enabled: true },
          { id: 11, rewardDefinitionId: 101, tierKey: 'rare', enabled: true },
          { id: null, rewardDefinitionId: 102, tierKey: 'common', enabled: false },
        ],
      },
      savedContents,
      ids
    );
    expect(plan.newContents).toEqual([
      { boxDefinitionId: BOX, tierId: 1, rewardDefinitionId: 102, enabled: false },
    ]);
    expect(plan.changedContents).toEqual([{ id: 10, tierId: 2, enabled: true }]);
  });

  it('updates a content that was only disabled', () => {
    const [first, second] = contentsAsSaved();
    const plan = planContentWrites(
      BOX,
      { contents: [first, { ...second, enabled: false }] },
      savedContents,
      ids
    );
    expect(plan.changedContents).toEqual([{ id: 11, tierId: 2, enabled: false }]);
  });

  it('refuses a content in a tier the box does not have', () => {
    const refuse = () =>
      planContentWrites(
        BOX,
        { contents: [{ id: null, rewardDefinitionId: 102, tierKey: 'epic', enabled: true }] },
        savedContents,
        ids
      );
    expect(refuse).toThrow(BoxRefusal);
    expect(refuse).toThrow("Reward #102 is in a tier the box doesn't have.");
  });
});

describe('keptContentIds', () => {
  it('keeps the saved contents the draft still lists', () => {
    expect(
      keptContentIds({
        contents: [
          { id: 11, rewardDefinitionId: 101, tierKey: 'rare', enabled: true },
          { id: null, rewardDefinitionId: 102, tierKey: 'rare', enabled: true },
        ],
      })
    ).toEqual([11]);
  });
});

describe('boxParamsForSave', () => {
  const draft = {
    event: ' birthday ',
    emptyRule: 'keep' as const,
    art: { red: { closed: 'a.png' } },
  };

  it("writes the draft's trimmed event, rule and art over the saved ones, keeping the rest", () => {
    expect(
      boxParamsForSave(
        { event: 'old', emptyRule: 'keep', art: { red: { closed: 'old.png' } }, other: 1 },
        draft
      )
    ).toEqual({
      event: 'birthday',
      params: { other: 1, event: 'birthday', emptyRule: 'keep', art: { red: { closed: 'a.png' } } },
    });
  });

  it('drops the event when the draft clears it', () => {
    expect(boxParamsForSave({ event: 'old' }, { ...draft, event: '  ' })).toEqual({
      event: null,
      params: { emptyRule: 'keep', art: { red: { closed: 'a.png' } } },
    });
  });
});
