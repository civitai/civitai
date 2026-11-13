import { describe, expect, it } from 'vitest';
import { designName, type CatalogDesign, type FlowReward } from '$lib/box-design';
import {
  addDesigns,
  applyOneTier,
  applyPricePreset,
  bandOf,
  DEFAULT_BANDS,
  fillByPrice,
  flowChecklist,
  groupByDesign,
  handPlacedCount,
  moveRewards,
  newTier,
  oddsByTeam,
  placeByBands,
  placeDesigns,
  presenceOf,
  teamsDiffer,
} from '$lib/box-flow';
import { boxChecklist, type BoxDraft, type DraftContent, type DraftTier } from '$lib/mystery-box';

const TEAMS = ['Blue', 'Pink'];

let nextId = 100;
const reward = (over: Partial<FlowReward> & { name: string }): FlowReward => {
  const made = {
    id: nextId++,
    type: 'cosmetic',
    cosmeticId: nextId,
    team: null,
    imageUrl: null,
    shelf: null,
    design: over.name,
    ...over,
  };
  return { designKey: `k|${made.design}`, ...made };
};
const rewardsOf = (...list: FlowReward[]) => new Map(list.map((r) => [r.id, r]));
const row = (rewardDefinitionId: number, tierKey: string, enabled = true): DraftContent => ({
  id: null,
  rewardDefinitionId,
  tierKey,
  enabled,
});
const tier = (key: string, weight: number, id: number | null = null): DraftTier => ({
  id,
  key,
  name: key[0].toUpperCase() + key.slice(1),
  weight,
  color: null,
});
const draftOf = (tiers: DraftTier[], contents: DraftContent[], over: Partial<BoxDraft> = {}) => ({
  name: 'Box',
  event: 'party',
  tiers,
  contents,
  ...over,
});

function fixture() {
  const capBlue = reward({ name: 'Cap - Blue', design: 'Cap', team: 'Blue', shelf: 500 });
  const capPink = reward({ name: 'Cap - Pink', design: 'Cap', team: 'Pink', shelf: 500 });
  const crownBlue = reward({ name: 'Crown - Blue', design: 'Crown', team: 'Blue', shelf: 3000 });
  const crownPink = reward({ name: 'Crown - Pink', design: 'Crown', team: 'Pink', shelf: 3000 });
  const pin = reward({ name: 'Pin', shelf: null });
  return {
    capBlue,
    capPink,
    crownBlue,
    crownPink,
    pin,
    rewards: rewardsOf(capBlue, capPink, crownBlue, crownPink, pin),
  };
}

describe('designName', () => {
  it('strips the team the cosmetic was made for, and only that suffix', () => {
    expect(designName('Patchwork Fox Hat - Pink', 'Pink')).toBe('Patchwork Fox Hat');
    expect(designName('Patchwork Fox Hat - Pink', 'Blue')).toBe('Patchwork Fox Hat - Pink');
    expect(designName('Patchwork Fox Hat - Pink', null)).toBe('Patchwork Fox Hat - Pink');
    expect(designName(' - Pink', 'Pink')).toBe(' - Pink');
  });
});

describe('price presets', () => {
  it('puts the lines at 500 and 1,500, and leaves a cosmetic with no price unplaced', () => {
    expect([500, 501, 1500, 1501, null].map((shelf) => bandOf(shelf, DEFAULT_BANDS))).toEqual([
      'uncommon',
      'rare',
      'rare',
      'legendary',
      null,
    ]);
  });

  it("applies the three tiers, keeps a saved tier's id, and sorts priced items by band", () => {
    const f = fixture();
    const contents = [row(f.capBlue.id, 'old'), row(f.crownBlue.id, 'old'), row(f.pin.id, 'old')];
    const result = applyPricePreset(
      { tiers: [tier('old', 1, 7), tier('rare', 9, 8)], contents },
      f.rewards,
      DEFAULT_BANDS
    );
    expect(result.tiers.map((t) => [t.key, t.id, t.weight])).toEqual([
      ['uncommon', null, 54],
      ['rare', 8, 9],
      ['legendary', null, 12],
    ]);
    const tierOf = (id: number) =>
      result.contents.find((c) => c.rewardDefinitionId === id)!.tierKey;
    expect(tierOf(f.capBlue.id)).toBe('uncommon');
    expect(tierOf(f.crownBlue.id)).toBe('legendary');
    expect(tierOf(f.pin.id)).toBe('uncommon');
  });

  it('counts hand placements and re-sorts them, but never moves an unpriced item', () => {
    const f = fixture();
    const tiers = applyPricePreset({ tiers: [], contents: [] }, f.rewards, DEFAULT_BANDS).tiers;
    const contents = [
      row(f.capBlue.id, 'legendary'),
      row(f.crownBlue.id, 'legendary'),
      row(f.pin.id, 'rare'),
    ];
    expect(handPlacedCount({ tiers, contents }, f.rewards, DEFAULT_BANDS)).toBe(1);
    const sorted = placeByBands({ tiers, contents }, f.rewards, DEFAULT_BANDS);
    expect(sorted.map((c) => c.tierKey)).toEqual(['uncommon', 'legendary', 'rare']);
  });

  it('a one-tier box holds everything in one tier', () => {
    const f = fixture();
    const result = applyOneTier({
      tiers: [tier('a', 1)],
      contents: [row(f.capBlue.id, 'a'), row(f.pin.id, 'a')],
    });
    expect(result.tiers).toHaveLength(1);
    expect(new Set(result.contents.map((c) => c.tierKey))).toEqual(new Set(['all']));
  });

  it('makes a tier key from the name and refuses a key the box already has', () => {
    expect(newTier([], 'Super Rare!')).toMatchObject({
      tier: { key: 'super-rare', name: 'Super Rare!', id: null },
    });
    expect(newTier([tier('epic', 1)], 'Epic')).toEqual({
      error: 'This box already has a tier with that name.',
    });
    expect(newTier([], '   ')).toEqual({ error: 'Give the tier a name.' });
    expect(newTier([], '!!!')).toEqual({ error: 'Use letters or digits in the name.' });
  });
});

describe('designs', () => {
  it("groups a design's team variants into one row per tier", () => {
    const f = fixture();
    const contents = [
      row(f.capBlue.id, 'a'),
      row(f.capPink.id, 'a'),
      row(f.crownBlue.id, 'a'),
      row(f.crownPink.id, 'b'),
    ];
    const groups = groupByDesign(contents, f.rewards);
    expect(groups.map((g) => [g.design, g.tierKey, g.rows.length])).toEqual([
      ['Cap', 'a', 2],
      ['Crown', 'a', 1],
      ['Crown', 'b', 1],
    ]);
  });

  it('adds every variant that has a definition, once, and skips the rest', () => {
    const f = fixture();
    const design: CatalogDesign = {
      key: 'k',
      name: 'Cap',
      type: 'ContentDecoration',
      event: 'party',
      shelf: 500,
      variants: [
        {
          cosmeticId: 1,
          definitionId: f.capBlue.id,
          name: 'Cap - Blue',
          team: 'Blue',
          url: null,
          shelf: 500,
        },
        {
          cosmeticId: 2,
          definitionId: null,
          name: 'Cap - Pink',
          team: 'Pink',
          url: null,
          shelf: null,
        },
      ],
    };
    const first = addDesigns([], [design], 'a');
    expect(first.contents.map((c) => c.rewardDefinitionId)).toEqual([f.capBlue.id]);
    expect(first.rewards[0]).toMatchObject({
      design: 'Cap',
      designKey: 'k',
      shelf: 500,
      team: 'Blue',
    });
    expect(addDesigns(first.contents, [design], 'a').contents).toHaveLength(1);
  });

  it('tells which tiers a design is in, and moves only the rows asked for', () => {
    const f = fixture();
    const contents = [row(f.capBlue.id, 'a'), row(f.capPink.id, 'b')];
    const design: CatalogDesign = {
      key: 'k',
      name: 'Cap',
      type: 't',
      event: 'party',
      shelf: 500,
      variants: [
        {
          cosmeticId: 1,
          definitionId: f.capBlue.id,
          name: 'x',
          team: 'Blue',
          url: null,
          shelf: null,
        },
        {
          cosmeticId: 2,
          definitionId: f.capPink.id,
          name: 'y',
          team: 'Pink',
          url: null,
          shelf: null,
        },
        { cosmeticId: 3, definitionId: null, name: 'z', team: 'Green', url: null, shelf: null },
      ],
    };
    const byReward = new Map(contents.map((c) => [c.rewardDefinitionId, c]));
    expect(presenceOf(design, byReward)).toEqual({ inBox: 2, tierKeys: ['a', 'b'] });
    const moved = moveRewards(contents, new Set([f.capPink.id]), 'a');
    expect(moved.moved).toBe(1);
    expect(moved.contents.map((c) => c.tierKey)).toEqual(['a', 'a']);
  });
});

describe('placing designs', () => {
  const design = (
    name: string,
    shelf: number | null,
    variants: [number | null, string | null, number | null][]
  ): CatalogDesign => ({
    key: `k|${name}`,
    name,
    type: 'ContentDecoration',
    event: 'party',
    shelf,
    variants: variants.map(([definitionId, team, price], i) => ({
      cosmeticId: i + 1,
      definitionId,
      name: `${name} - ${team}`,
      team,
      url: null,
      shelf: price,
    })),
  });

  it('moves the designs already in the box and adds the rest, counting each', () => {
    const f = fixture();
    const cap = design('Cap', 500, [
      [f.capBlue.id, 'Blue', 500],
      [f.capPink.id, 'Pink', 500],
    ]);
    const crown = design('Crown', 3000, [[f.crownBlue.id, 'Blue', 3000]]);
    const result = placeDesigns([row(f.capBlue.id, 'a')], [cap, crown], 'b');
    expect(result).toMatchObject({ added: 2, moved: 1 });
    expect(result.contents.map((c) => [c.rewardDefinitionId, c.tierKey])).toEqual([
      [f.capBlue.id, 'b'],
      [f.capPink.id, 'b'],
      [f.crownBlue.id, 'b'],
    ]);
  });

  it('fills the price tiers from an event and says what it left out', () => {
    const f = fixture();
    const cap = design('Cap', 500, [[f.capBlue.id, 'Blue', 500]]);
    const crown = design('Crown', 3000, [[f.crownBlue.id, 'Blue', 3000]]);
    const noPrice = design('Pin', null, [[f.pin.id, null, null]]);
    const noDefinition = design('Ghost', 1000, [[null, 'Blue', 1000]]);
    const result = fillByPrice(
      { tiers: [], contents: [] },
      f.rewards,
      [cap, crown, noPrice, noDefinition],
      DEFAULT_BANDS
    );
    expect(result.tiers.map((t) => t.key)).toEqual(['uncommon', 'rare', 'legendary']);
    expect(result.contents.map((c) => c.tierKey)).toEqual(['uncommon', 'legendary']);
    expect(result).toMatchObject({ added: 2, noPrice: 1, noDefinition: 1 });
  });

  it('places a design by its lowest variant price, so its variants stay together', () => {
    const cheap = reward({
      name: 'Cap - Blue',
      design: 'Cap',
      designKey: 'k|Cap',
      team: 'Blue',
      shelf: 500,
    });
    const dear = reward({
      name: 'Cap - Pink',
      design: 'Cap',
      designKey: 'k|Cap',
      team: 'Pink',
      shelf: 3000,
    });
    const rewards = rewardsOf(cheap, dear);
    const tiering = {
      tiers: applyPricePreset({ tiers: [], contents: [] }, rewards, DEFAULT_BANDS).tiers,
      contents: [row(cheap.id, 'legendary'), row(dear.id, 'uncommon')],
    };
    expect(placeByBands(tiering, rewards, DEFAULT_BANDS).map((c) => c.tierKey)).toEqual([
      'uncommon',
      'uncommon',
    ]);
    expect(handPlacedCount(tiering, rewards, DEFAULT_BANDS)).toBe(1);
  });
});

describe('odds by team', () => {
  const tiers = [tier('uncommon', 70), tier('legendary', 30)];

  it("matches the draw's own odds and the expected shelf price of a draw", () => {
    const f = fixture();
    const draft = draftOf(tiers, [
      row(f.capBlue.id, 'uncommon'),
      row(f.capPink.id, 'uncommon'),
      row(f.crownBlue.id, 'legendary'),
      row(f.crownPink.id, 'legendary'),
    ]);
    const odds = oddsByTeam(draft, f.rewards, TEAMS);
    expect(odds.map((o) => o.team)).toEqual(TEAMS);
    expect(odds[0].tiers.map((t) => [t.share, t.count, t.eligible])).toEqual([
      [0.7, 1, true],
      [0.3, 1, true],
    ]);
    expect(odds[0].avgShelf).toBeCloseTo(0.7 * 500 + 0.3 * 3000);
    expect(teamsDiffer(odds)).toBe(false);
  });

  it('leaves unpriced items out of the average and counts them', () => {
    const f = fixture();
    const draft = draftOf(
      [tier('only', 1)],
      [row(f.capBlue.id, 'only'), row(f.capPink.id, 'only'), row(f.pin.id, 'only')]
    );
    const [blue] = oddsByTeam(draft, f.rewards, ['Blue']);
    expect(blue.unpriced).toBe(1);
    expect(blue.avgShelf).toBe(500);
  });

  it('re-weights the average over the draws that have a price, even when a whole tier has none', () => {
    const f = fixture();
    const draft = draftOf(
      [tier('uncommon', 54), tier('rare', 34), tier('legendary', 12)],
      [row(f.capBlue.id, 'uncommon'), row(f.crownBlue.id, 'rare'), row(f.pin.id, 'legendary')]
    );
    const [blue] = oddsByTeam(draft, f.rewards, ['Blue']);
    expect(blue.unpriced).toBe(1);
    expect(blue.avgShelf).toBeCloseTo((0.54 * 500 + 0.34 * 3000) / 0.88);
  });

  it('splits by team when a tier has nothing for one, and the others take its share', () => {
    const f = fixture();
    const draft = draftOf(tiers, [
      row(f.capBlue.id, 'uncommon'),
      row(f.capPink.id, 'uncommon'),
      row(f.crownBlue.id, 'legendary'),
      row(f.crownPink.id, 'legendary', false),
    ]);
    const [blue, pink] = oddsByTeam(draft, f.rewards, TEAMS);
    expect(blue.tiers[1].eligible).toBe(true);
    expect(pink.tiers[1].eligible).toBe(false);
    expect(pink.tiers[0].share).toBe(1);
    expect(teamsDiffer([blue, pink])).toBe(true);
  });

  it('with no event there is one buyer with no team, who draws only team-less cosmetics', () => {
    const f = fixture();
    const draft = draftOf(tiers, [row(f.pin.id, 'uncommon'), row(f.capBlue.id, 'legendary')], {
      event: '',
    });
    const odds = oddsByTeam(draft, f.rewards, []);
    expect(odds).toHaveLength(1);
    expect(odds[0].team).toBeNull();
    expect(odds[0].tiers.map((t) => t.eligible)).toEqual([true, false]);
  });
});

describe('flowChecklist', () => {
  const f = fixture();
  const good = draftOf(
    [tier('uncommon', 70), tier('legendary', 30)],
    [
      row(f.capBlue.id, 'uncommon'),
      row(f.capPink.id, 'uncommon'),
      row(f.crownBlue.id, 'legendary'),
      row(f.crownPink.id, 'legendary'),
    ]
  );
  const extra = reward({ name: 'Green Hat', team: 'Green' });
  const aBox = reward({ name: 'Mini Box', type: 'box' });
  const aSticker = reward({ name: 'Sticker', type: 'sticker' });
  const rewards = new Map([
    ...f.rewards,
    [extra.id, extra],
    [aBox.id, aBox],
    [aSticker.id, aSticker],
  ]);

  const corpus: [string, ReturnType<typeof draftOf>, string[]][] = [
    ['none', good, TEAMS],
    ['no name', { ...good, name: '  ' }, TEAMS],
    ['no tiers', draftOf([], []), TEAMS],
    [
      'tier without a name',
      { ...good, tiers: [{ ...good.tiers[0], name: ' ' }, good.tiers[1]] },
      TEAMS,
    ],
    ['zero weight', { ...good, tiers: [{ ...good.tiers[0], weight: 0 }, good.tiers[1]] }, TEAMS],
    [
      'fractional weight',
      { ...good, tiers: [{ ...good.tiers[0], weight: 1.5 }, good.tiers[1]] },
      TEAMS,
    ],
    [
      'weights over the most',
      { ...good, tiers: [{ ...good.tiers[0], weight: 2_147_483_647 }, good.tiers[1]] },
      TEAMS,
    ],
    [
      'two tiers share a key',
      { ...good, tiers: [good.tiers[0], { ...good.tiers[1], key: 'uncommon' }] },
      TEAMS,
    ],
    ['bad key', { ...good, tiers: [{ ...good.tiers[0], key: 'Bad Key' }, good.tiers[1]] }, TEAMS],
    [
      'reward twice',
      { ...good, contents: [...good.contents, row(f.capBlue.id, 'uncommon')] },
      TEAMS,
    ],
    ['tier missing', { ...good, contents: [...good.contents, row(f.pin.id, 'nope')] }, TEAMS],
    [
      'reward does not exist',
      { ...good, contents: [...good.contents, row(99999, 'uncommon')] },
      TEAMS,
    ],
    ['a box in a box', { ...good, contents: [...good.contents, row(aBox.id, 'uncommon')] }, TEAMS],
    [
      'not a cosmetic',
      { ...good, contents: [...good.contents, row(aSticker.id, 'uncommon')] },
      TEAMS,
    ],
    [
      'team the event lacks',
      { ...good, contents: [...good.contents, row(extra.id, 'uncommon')] },
      TEAMS,
    ],
    ['team but no event', { ...good, contents: [...good.contents, row(extra.id, 'uncommon')] }, []],
    [
      'tier empty for a team',
      { ...good, contents: good.contents.filter((c) => c.rewardDefinitionId !== f.crownPink.id) },
      TEAMS,
    ],
    [
      'tier off for a team',
      {
        ...good,
        contents: good.contents.map((c) =>
          c.rewardDefinitionId === f.crownPink.id ? { ...c, enabled: false } : c
        ),
      },
      TEAMS,
    ],
    ['event hats with no event', good, []],
  ];

  it.each(corpus)('refuses exactly when the gate does: %s', (_label, draft, teams) => {
    const gate = boxChecklist(draft, rewards, teams);
    const { problems } = flowChecklist(draft, rewards, teams);
    expect(problems.length > 0).toBe(gate.length > 0);
    // A problem with no `fix` is the gate's own wording: a rule flowChecklist doesn't name yet.
    expect(problems.every((p) => p.fix)).toBe(true);
  });

  it('names the item, the tier and the team, never an id', () => {
    const draft = {
      ...good,
      contents: good.contents.filter((c) => c.rewardDefinitionId !== f.crownPink.id),
    };
    const { problems } = flowChecklist(draft, rewards, TEAMS);
    expect(problems).toEqual([
      {
        message: 'Legendary has nothing for team Pink.',
        fix: { step: 'items', tierKey: 'legendary' },
      },
    ]);
    const twice = flowChecklist(
      { ...good, contents: [...good.contents, row(f.capBlue.id, 'uncommon')] },
      rewards,
      TEAMS
    );
    expect(twice.problems[0].message).toBe('Cap - Blue is in the box twice.');
    for (const [, draftOf2, teams] of corpus)
      for (const p of flowChecklist(draftOf2, rewards, teams).problems)
        expect(p.message).not.toMatch(/#\d+/);
  });

  it('sends a team problem caused by a missing event to the basics', () => {
    const { problems } = flowChecklist(
      { ...good, contents: [...good.contents, row(extra.id, 'uncommon')] },
      rewards,
      []
    );
    expect(problems.find((p) => p.message.startsWith('Green Hat'))?.fix).toEqual({
      step: 'basics',
    });
  });

  it('passes a clean box with nothing to fix', () => {
    const { problems, passed } = flowChecklist(good, rewards, TEAMS);
    expect(problems).toEqual([]);
    expect(passed.map((p) => p.message)).toContain('Every tier holds something for every team.');
  });
});
