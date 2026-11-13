import { MAX_BOX_WEIGHT } from '@civitai/shared/box-odds';
import { isForTeam } from '@civitai/shared/mystery-box';
import { isDefined, rewardOfVariant, type CatalogDesign, type FlowReward } from '$lib/box-design';
import {
  boxChecklist,
  ITEM_TYPE,
  previewOdds,
  TIER_KEY_PATTERN,
  type BoxDraft,
  type DraftContent,
  type DraftTier,
} from '$lib/mystery-box';

type Rewards = ReadonlyMap<number, FlowReward>;
type Tiering = Pick<BoxDraft, 'tiers' | 'contents'>;

export const percent = (p: number) => `${(p * 100).toFixed(p < 0.01 ? 3 : p < 0.1 ? 2 : 1)}%`;

export type TierPreset = 'price' | 'one' | 'custom';

export const isPriceTiering = (tiers: DraftTier[]) =>
  tiers.length > 0 && tiers.every((tier) => PRICE_TIERS.some((preset) => preset.key === tier.key));

export type PriceBands = { uncommon: number; rare: number };
export const DEFAULT_BANDS: PriceBands = { uncommon: 500, rare: 1500 };

export const PRICE_TIERS = [
  { key: 'uncommon', name: 'Uncommon', color: '#22c55e', weight: 54 },
  { key: 'rare', name: 'Rare', color: '#3b82f6', weight: 34 },
  { key: 'legendary', name: 'Legendary', color: '#f59e0b', weight: 12 },
] as const;
export type PriceTierKey = (typeof PRICE_TIERS)[number]['key'];

export const bandOf = (shelf: number | null, bands: PriceBands): PriceTierKey | null =>
  shelf === null
    ? null
    : shelf <= bands.uncommon
    ? 'uncommon'
    : shelf <= bands.rare
    ? 'rare'
    : 'legendary';

/** A design's variants are priced separately; the design is placed by the lowest, as the catalog shows it. */
function designShelves(contents: DraftContent[], rewards: Rewards) {
  const shelves = new Map<string, number | null>();
  for (const content of contents) {
    const reward = rewards.get(content.rewardDefinitionId);
    if (!reward) continue;
    const seen = shelves.get(reward.designKey);
    const price = reward.shelf;
    shelves.set(
      reward.designKey,
      seen === undefined || seen === null ? price : price === null ? seen : Math.min(seen, price)
    );
  }
  return shelves;
}

function bandKeyOf(
  content: DraftContent,
  rewards: Rewards,
  shelves: Map<string, number | null>,
  bands: PriceBands
) {
  const designKey = rewards.get(content.rewardDefinitionId)?.designKey;
  return bandOf((designKey === undefined ? null : shelves.get(designKey)) ?? null, bands);
}

export function placeByBands(
  { tiers, contents }: Tiering,
  rewards: Rewards,
  bands: PriceBands
): DraftContent[] {
  const shelves = designShelves(contents, rewards);
  return contents.map((content) => {
    const key = bandKeyOf(content, rewards, shelves, bands);
    return key && key !== content.tierKey && tiers.some((tier) => tier.key === key)
      ? { ...content, tierKey: key }
      : content;
  });
}

/** Designs with a priced variant outside the band's tier: what a re-sort would move. */
export function handPlacedCount({ tiers, contents }: Tiering, rewards: Rewards, bands: PriceBands) {
  const shelves = designShelves(contents, rewards);
  const designs = new Set<string>();
  for (const content of contents) {
    const key = bandKeyOf(content, rewards, shelves, bands);
    if (key !== null && key !== content.tierKey && tiers.some((tier) => tier.key === key))
      designs.add(
        rewards.get(content.rewardDefinitionId)?.designKey ?? `#${content.rewardDefinitionId}`
      );
  }
  return designs.size;
}

/** A tier the box already has keeps its id, name, weight and colour; only a missing one is made from the preset. */
export function applyPricePreset(
  { tiers, contents }: Tiering,
  rewards: Rewards,
  bands: PriceBands
): Tiering {
  const next: DraftTier[] = PRICE_TIERS.map(
    (preset) => tiers.find((tier) => tier.key === preset.key) ?? { id: null, ...preset }
  );
  const shelves = designShelves(contents, rewards);
  return {
    tiers: next,
    contents: contents.map((content) => {
      const key = bandKeyOf(content, rewards, shelves, bands);
      const kept = next.some((tier) => tier.key === content.tierKey)
        ? content.tierKey
        : PRICE_TIERS[0].key;
      const tierKey = key ?? kept;
      return tierKey === content.tierKey ? content : { ...content, tierKey };
    }),
  };
}

export function applyOneTier({ tiers, contents }: Tiering): Tiering {
  const tier: DraftTier = {
    id: tiers.find((existing) => existing.key === 'all')?.id ?? null,
    key: 'all',
    name: 'Everything',
    weight: 100,
    color: '#339af0',
  };
  return { tiers: [tier], contents: contents.map((content) => ({ ...content, tierKey: 'all' })) };
}

const TIER_COLORS = ['#868e96', '#845ef7', '#20c997', '#e64980', '#fab005', '#15aabf'];

/** A tier named by the moderator; its key is made from the name and is fixed once saved. */
export function newTier(tiers: DraftTier[], name: string): { tier: DraftTier } | { error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { error: 'Give the tier a name.' };
  const key = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  if (!TIER_KEY_PATTERN.test(key)) return { error: 'Use letters or digits in the name.' };
  if (tiers.some((tier) => tier.key === key))
    return { error: 'This box already has a tier with that name.' };
  return {
    tier: {
      id: null,
      key,
      name: trimmed,
      weight: 10,
      color: TIER_COLORS[tiers.length % TIER_COLORS.length],
    },
  };
}

/** One design in one tier: the rows of its team variants. */
export type DesignGroup = {
  id: string;
  tierKey: string;
  design: string;
  shelf: number | null;
  imageUrl: string | null;
  rows: DraftContent[];
};

export function groupByDesign(contents: DraftContent[], rewards: Rewards): DesignGroup[] {
  const groups = new Map<string, DesignGroup>();
  for (const row of contents) {
    const reward = rewards.get(row.rewardDefinitionId);
    // A tier key never holds '|', so the id is unambiguous even when a design name does.
    const id = `${row.tierKey}|${reward?.designKey ?? `#${row.rewardDefinitionId}`}`;
    const group = groups.get(id);
    const price = reward?.shelf ?? null;
    if (group) {
      group.rows.push(row);
      if (price !== null && (group.shelf === null || price < group.shelf)) group.shelf = price;
    } else
      groups.set(id, {
        id,
        tierKey: row.tierKey,
        design: reward?.design ?? `#${row.rewardDefinitionId}`,
        shelf: price,
        imageUrl: reward?.imageUrl ?? null,
        rows: [row],
      });
  }
  return [...groups.values()].sort((a, b) => a.design.localeCompare(b.design));
}

export function presenceOf(design: CatalogDesign, byReward: ReadonlyMap<number, DraftContent>) {
  const rows = design.variants.flatMap((variant) => {
    const row = variant.definitionId === null ? undefined : byReward.get(variant.definitionId);
    return row ? [row] : [];
  });
  return { inBox: rows.length, tierKeys: [...new Set(rows.map((row) => row.tierKey))] };
}

export const definitionIds = (designs: CatalogDesign[]) =>
  new Set(
    designs.flatMap((design) =>
      design.variants.flatMap((variant) =>
        variant.definitionId === null ? [] : [variant.definitionId]
      )
    )
  );

/** Adds each variant that has a definition and isn't in the box. */
export function addDesigns(contents: DraftContent[], designs: CatalogDesign[], tierKey: string) {
  const inBox = new Set(contents.map((content) => content.rewardDefinitionId));
  const added: DraftContent[] = [];
  const rewards: FlowReward[] = [];
  for (const design of designs)
    for (const variant of design.variants) {
      const reward = rewardOfVariant(design, variant);
      if (!reward || inBox.has(reward.id)) continue;
      inBox.add(reward.id);
      rewards.push(reward);
      added.push({ id: null, rewardDefinitionId: reward.id, tierKey, enabled: true });
    }
  return { contents: [...contents, ...added], rewards };
}

export function moveRewards(
  contents: DraftContent[],
  rewardIds: ReadonlySet<number>,
  tierKey: string
) {
  let moved = 0;
  const next = contents.map((content) => {
    if (!rewardIds.has(content.rewardDefinitionId) || content.tierKey === tierKey) return content;
    moved += 1;
    return { ...content, tierKey };
  });
  return { contents: next, moved };
}

export const removeRewards = (contents: DraftContent[], rewardIds: ReadonlySet<number>) =>
  contents.filter((content) => !rewardIds.has(content.rewardDefinitionId));

/** Designs already in the box move to the tier; the rest are added to it. */
export function placeDesigns(contents: DraftContent[], designs: CatalogDesign[], tierKey: string) {
  const moved = moveRewards(contents, definitionIds(designs), tierKey);
  const added = addDesigns(moved.contents, designs, tierKey);
  return {
    contents: added.contents,
    rewards: added.rewards,
    added: added.contents.length - contents.length,
    moved: moved.moved,
  };
}

/** The price tiers, every priced and defined design placed by band, and what was left out. */
export function fillByPrice(
  draft: Tiering,
  rewards: Rewards,
  designs: CatalogDesign[],
  bands: PriceBands
) {
  const base = applyPricePreset(draft, rewards, bands);
  let contents = base.contents;
  const newRewards: FlowReward[] = [];
  let added = 0;
  for (const tier of PRICE_TIERS) {
    const picks = designs.filter(
      (design) => isDefined(design) && bandOf(design.shelf, bands) === tier.key
    );
    const result = addDesigns(contents, picks, tier.key);
    added += result.contents.length - contents.length;
    contents = result.contents;
    newRewards.push(...result.rewards);
  }
  return {
    tiers: base.tiers,
    contents,
    rewards: newRewards,
    added,
    noPrice: designs.filter((design) => design.shelf === null).length,
    noDefinition: designs.filter((design) => design.shelf !== null && !isDefined(design)).length,
  };
}

export type TierOdds = {
  tierKey: string;
  name: string;
  color: string | null;
  /** False when the tier holds nothing for this team: it drops out and the others take its share. */
  eligible: boolean;
  share: number;
  each: number;
  count: number;
};
/** `unpriced` items have no shelf price and are left out of `avgShelf`. */
export type TeamOdds = {
  team: string | null;
  tiers: TierOdds[];
  avgShelf: number;
  unpriced: number;
};

/** Base odds (nothing owned) per team via `previewOdds`. `avgShelf` is information, not a price rule. */
export function oddsByTeam(draft: Tiering, rewards: Rewards, teams: readonly string[]): TeamOdds[] {
  return (teams.length ? teams : [null]).map((team) => {
    const odds = previewOdds(draft, rewards, team);
    let priced = 0;
    let pricedValue = 0;
    let unpriced = 0;
    const tiers = draft.tiers.map((tier, index): TierOdds => {
      const found = odds?.tiers.find((entry) => entry.tierId === index);
      if (!found)
        return {
          tierKey: tier.key,
          name: tier.name,
          color: tier.color,
          eligible: false,
          share: 0,
          each: 0,
          count: 0,
        };
      const prices = found.contentIds.flatMap((contentId) => {
        const shelf = rewards.get(draft.contents[contentId].rewardDefinitionId)?.shelf ?? null;
        return shelf === null ? [] : [shelf];
      });
      unpriced += found.contentIds.length - prices.length;
      priced += found.itemProbability * prices.length;
      pricedValue += found.itemProbability * prices.reduce((sum, value) => sum + value, 0);
      return {
        tierKey: tier.key,
        name: tier.name,
        color: tier.color,
        eligible: true,
        share: found.probability,
        each: found.itemProbability,
        count: found.contentIds.length,
      };
    });
    return { team, tiers, avgShelf: priced > 0 ? pricedValue / priced : 0, unpriced };
  });
}

/** Teams whose odds match are shown as one column; they split only when something differs. */
export function teamsDiffer(odds: TeamOdds[]): boolean {
  const signature = (entry: TeamOdds) =>
    entry.tiers.map((tier) => `${tier.eligible}:${tier.share.toFixed(9)}:${tier.count}`).join('|') +
    `#${Math.round(entry.avgShelf)}`;
  return odds.some((entry) => signature(entry) !== signature(odds[0]));
}

export type FixTarget = { step: 'basics' | 'items'; tierKey?: string };
export type FlowProblem = { message: string; fix?: FixTarget };
export type FlowNote = { message: string; info?: boolean };

/**
 * A second rendering of `boxChecklist` (the gate the server enforces) with named items and fix targets.
 * box-flow.test.ts pins both to the same verdict; a refusal none of the named rules caught is shown in the gate's own words.
 */
export function flowChecklist(
  draft: Pick<BoxDraft, 'name' | 'event' | 'tiers' | 'contents'>,
  rewards: Rewards,
  teams: readonly string[]
): { problems: FlowProblem[]; passed: FlowNote[] } {
  const problems: FlowProblem[] = [];
  const passed: FlowNote[] = [];
  const nameOf = (id: number) => rewards.get(id)?.name ?? `Item ${id}`;

  if (draft.name.trim()) passed.push({ message: `Named "${draft.name.trim()}".` });
  else problems.push({ message: 'The box needs a name.', fix: { step: 'basics' } });

  passed.push(
    draft.event
      ? { message: `Event ${draft.event}: buyers are on ${teams.join(', ') || 'no team yet'}.` }
      : {
          message: 'No event: buyers have no team, so they draw only cosmetics made for no team.',
          info: true,
        }
  );

  const tierProblems = problems.length;
  if (!draft.tiers.length)
    problems.push({ message: 'The box needs at least one tier.', fix: { step: 'items' } });
  const keys = new Set<string>();
  let totalWeight = 0;
  for (const tier of draft.tiers) {
    const label = tier.name.trim() || tier.key || 'A tier';
    const fix: FixTarget = { step: 'items', tierKey: tier.key };
    if (!TIER_KEY_PATTERN.test(tier.key))
      problems.push({
        message: `${label}: the key must be 1-32 lowercase letters, digits or dashes.`,
        fix,
      });
    else if (keys.has(tier.key))
      problems.push({ message: `Two tiers share the key "${tier.key}".`, fix });
    keys.add(tier.key);
    if (!tier.name.trim()) problems.push({ message: `Tier "${tier.key}" needs a name.`, fix });
    if (!Number.isSafeInteger(tier.weight) || tier.weight <= 0)
      problems.push({ message: `${label}: the weight must be a whole number above 0.`, fix });
    else totalWeight += tier.weight;
  }
  if (totalWeight > MAX_BOX_WEIGHT)
    problems.push({
      message: `The weights add up to ${totalWeight}; the most is ${MAX_BOX_WEIGHT}.`,
      fix: { step: 'items' },
    });
  if (draft.tiers.length && problems.length === tierProblems)
    passed.push({
      message: `${draft.tiers.length} tier${
        draft.tiers.length > 1 ? 's' : ''
      }, weights add up to ${totalWeight}.`,
    });

  const seen = new Set<number>();
  const enabled: { tierKey: string; team: string | null }[] = [];
  for (const content of draft.contents) {
    const name = nameOf(content.rewardDefinitionId);
    const fix: FixTarget = { step: 'items', tierKey: content.tierKey };
    if (seen.has(content.rewardDefinitionId))
      problems.push({ message: `${name} is in the box twice.`, fix });
    seen.add(content.rewardDefinitionId);
    if (!keys.has(content.tierKey))
      problems.push({ message: `${name} is in a tier the box doesn't have.`, fix });
    if (!content.enabled) continue;
    const reward = rewards.get(content.rewardDefinitionId);
    if (!reward) {
      problems.push({ message: `${name} doesn't exist.`, fix });
      continue;
    }
    if (reward.type === ITEM_TYPE.box) {
      problems.push({ message: `${name} is a box; a box can't hold a box.`, fix });
      continue;
    }
    if (reward.type !== ITEM_TYPE.cosmetic) {
      problems.push({ message: `${name} isn't a cosmetic; boxes hold cosmetics only.`, fix });
      continue;
    }
    if (reward.team !== null && !teams.includes(reward.team))
      problems.push({
        message: teams.length
          ? `${name} is made for team ${reward.team}, which isn't one of this event's teams.`
          : `${name} is made for team ${reward.team}, but this box has no event team, so nobody can draw it.`,
        fix: teams.length ? fix : { step: 'basics' },
      });
    enabled.push({ tierKey: content.tierKey, team: reward.team });
  }

  const before = problems.length;
  for (const team of teams.length ? teams : [undefined]) {
    const inTier = new Set(
      enabled
        .filter((content) => isForTeam(content.team ?? undefined, team))
        .map((content) => content.tierKey)
    );
    for (const tier of draft.tiers)
      if (!inTier.has(tier.key))
        problems.push({
          message: `${tier.name || tier.key} has nothing for ${
            team === undefined ? 'a buyer with no team' : `team ${team}`
          }.`,
          fix: { step: 'items', tierKey: tier.key },
        });
  }
  if (draft.tiers.length && problems.length === before)
    passed.push({
      message: `Every tier holds something for ${
        teams.length ? 'every team' : 'a buyer with no team'
      }.`,
    });
  passed.push({ message: 'Only cosmetics can be picked, and no box can go in a box.', info: true });

  if (!problems.length)
    for (const message of boxChecklist(draft, rewards, teams)) problems.push({ message });
  return { problems, passed };
}
