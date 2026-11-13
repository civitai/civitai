import { describe, expect, it } from 'vitest';
import {
  assertDraftFitsRows,
  boxChecklist,
  boxParamsForSave,
  BoxRefusal,
  keptContentIds,
  oddsChanged,
  planContentWrites,
  planTierWrites,
  tierIdsWithInserted,
  type BoxContentRow,
  type BoxDraft,
  type BoxTierRow,
  type DraftContent,
  type DraftTier,
  type RewardInfo,
} from '../box-builder';
import { snapshotOfLiveBox } from '../box-odds-snapshot';

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

describe('tierIdsWithInserted', () => {
  const [common, rare] = asSaved();
  const withEpic = () =>
    planTierWrites(
      BOX,
      { tiers: [common, rare, { id: null, key: 'epic', name: 'Epic', weight: 5, color: null }] },
      savedTiers
    );

  it("adds the inserted tiers' ids to the kept tiers' ids", () => {
    expect(tierIdsWithInserted(withEpic(), [{ id: 3, key: 'epic' }])).toEqual(
      new Map([
        ['common', 1],
        ['rare', 2],
        ['epic', 3],
      ])
    );
  });

  it('throws when the insert returned no id for a new tier', () => {
    expect(() => tierIdsWithInserted(withEpic(), [])).toThrow(
      'The tier insert returned no id for "epic".'
    );
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

const reward = (id: number, team: string | null, type = 'cosmetic') =>
  [id, { type, team }] as [number, Pick<RewardInfo, 'type' | 'team'>];

const checklistDraft = (
  contents: [rewardDefinitionId: number, tierKey: string, enabled?: boolean][],
  weights: [number, number] = [3, 1]
): Pick<BoxDraft, 'name' | 'tiers' | 'contents'> => ({
  name: 'Box',
  tiers: [
    { id: null, key: 'common', name: 'Common', weight: weights[0], color: null },
    { id: null, key: 'rare', name: 'Rare', weight: weights[1], color: null },
  ],
  contents: contents.map(([rewardDefinitionId, tierKey, enabled = true]) => ({
    id: null,
    rewardDefinitionId,
    tierKey,
    enabled,
  })),
});

describe('boxChecklist', () => {
  const rewards = new Map([
    reward(1, 'Blue'),
    reward(2, 'Pink'),
    reward(3, 'Blue'),
    reward(4, 'Pink'),
    reward(5, null),
  ]);

  it('passes a box with every tier stocked for every team', () => {
    expect(
      boxChecklist(
        checklistDraft([
          [1, 'common'],
          [2, 'common'],
          [3, 'rare'],
          [4, 'rare'],
        ]),
        rewards,
        ['Blue', 'Pink']
      )
    ).toEqual([]);
  });

  it('names the tier and team left empty', () => {
    expect(
      boxChecklist(
        checklistDraft([
          [1, 'common'],
          [2, 'common'],
          [3, 'rare'],
        ]),
        rewards,
        ['Blue', 'Pink']
      )
    ).toEqual(['Rare has nothing for team Pink.']);
  });

  it('counts a disabled reward as absent', () => {
    expect(
      boxChecklist(
        checklistDraft([
          [1, 'common'],
          [2, 'common'],
          [3, 'rare'],
          [4, 'rare', false],
        ]),
        rewards,
        ['Blue', 'Pink']
      )
    ).toEqual(['Rare has nothing for team Pink.']);
  });

  it('fills a tier for every team with a reward made for no team', () => {
    expect(
      boxChecklist(
        checklistDraft([
          [1, 'common'],
          [2, 'common'],
          [5, 'rare'],
        ]),
        rewards,
        ['Blue', 'Pink']
      )
    ).toEqual([]);
  });

  it('with no teams, requires every tier to hold a cosmetic made for no team', () => {
    expect(boxChecklist(checklistDraft([[5, 'common']]), rewards, [])).toEqual([
      'Rare has nothing in it.',
    ]);
  });

  it('refuses a cosmetic made for a team no buyer is on', () => {
    // A box with no event: its buyers have no team, so a team hat is never drawn.
    expect(
      boxChecklist(
        checklistDraft([
          [5, 'common'],
          [1, 'rare'],
        ]),
        rewards,
        []
      )
    ).toEqual([
      "Reward #1 is made for team Blue, but this box's buyers have no team, so nobody can draw it.",
      'Rare has nothing in it.',
    ]);
    expect(
      boxChecklist(
        checklistDraft([
          [1, 'common'],
          [2, 'common'],
          [3, 'rare'],
          [4, 'rare'],
        ]),
        rewards,
        ['Blue']
      )
    ).toEqual([
      "Reward #2 is made for team Pink, which isn't one of this event's teams.",
      "Reward #4 is made for team Pink, which isn't one of this event's teams.",
    ]);
  });

  it('refuses a weight of 0, a box inside a box, and any reward that is not a cosmetic', () => {
    const odd = new Map([...rewards, reward(7, null, 'box'), reward(8, null, 'buzz')]);
    expect(
      boxChecklist(
        checklistDraft(
          [
            [5, 'common'],
            [7, 'rare'],
            [8, 'rare'],
          ],
          [3, 0]
        ),
        odd,
        []
      )
    ).toEqual([
      'Rare: the weight must be a whole number above 0.',
      "Reward #7 is a box; a box can't hold a box.",
      "Reward #8 isn't a cosmetic; boxes hold cosmetics only.",
      'Rare has nothing in it.',
    ]);
  });

  it('refuses a reward listed twice', () => {
    expect(
      boxChecklist(
        checklistDraft([
          [5, 'common'],
          [5, 'rare'],
        ]),
        rewards,
        []
      )
    ).toContain('Reward #5 is in the box twice.');
  });
});

describe('oddsChanged', () => {
  const live = snapshotOfLiveBox(
    [
      { id: 1, key: 'common', name: 'Common', weight: 80, sortOrder: 0 },
      { id: 2, key: 'rare', name: 'Rare', weight: 20, sortOrder: 1 },
    ],
    [
      { tierId: 1, cosmeticId: 10 },
      { tierId: 2, cosmeticId: 20 },
    ]
  );

  it('is false for the same odds under the same event', () => {
    expect(
      oddsChanged({ snapshot: live, event: 'party' }, { snapshot: live, event: 'party' })
    ).toBe(false);
  });

  it('is true when a weight changed', () => {
    const reweighted = {
      ...live,
      tiers: live.tiers.map((tier) => (tier.key === 'rare' ? { ...tier, weight: 30 } : tier)),
    };
    expect(
      oddsChanged({ snapshot: live, event: 'party' }, { snapshot: reweighted, event: 'party' })
    ).toBe(true);
  });

  it('is true when only the event changed', () => {
    expect(oddsChanged({ snapshot: live, event: 'party' }, { snapshot: live, event: null })).toBe(
      true
    );
  });
});
