import { MAX_BOX_WEIGHT } from '@civitai/shared/box-odds';
import { isForTeam } from '@civitai/shared/mystery-box';
import type { CatalogDesign, FlowReward } from '$lib/box-design';
import { rewardOfVariant } from '$lib/box-design';
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

/* ---------- tier presets ---------- */

/** How the moderator is placing tiers: by shelf price, one pool, or by hand. */
export type TierPreset = 'price' | 'one' | 'custom';

export type PriceBands = { uncommon: number; rare: number };
export const DEFAULT_BANDS: PriceBands = { uncommon: 500, rare: 1500 };

/** Cheaper on the shelf draws more often. These are the tiers and weights the birthday box already uses. */
export const PRICE_TIERS = [
  { key: 'uncommon', name: 'Uncommon', color: '#22c55e', weight: 54 },
  { key: 'rare', name: 'Rare', color: '#3b82f6', weight: 34 },
  { key: 'legendary', name: 'Legendary', color: '#f59e0b', weight: 12 },
] as const;
export type PriceTierKey = (typeof PRICE_TIERS)[number]['key'];

/** Null when the cosmetic has no shelf price: nothing places it for you. */
export const bandOf = (shelf: number | null, bands: PriceBands): PriceTierKey | null =>
  shelf === null ? null : shelf <= bands.uncommon ? 'uncommon' : shelf <= bands.rare ? 'rare' : 'legendary';

const bandTierOf = (content: DraftContent, rewards: Rewards, tiers: DraftTier[], bands: PriceBands) => {
  const key = bandOf(rewards.get(content.rewardDefinitionId)?.shelf ?? null, bands);
  return key && tiers.some((tier) => tier.key === key) ? key : null;
};

/** Moves every priced item to its band's tier, in the tiers the box already has. */
export function placeByBands(
  { tiers, contents }: Tiering,
  rewards: Rewards,
  bands: PriceBands
): DraftContent[] {
  return contents.map((content) => {
    const key = bandTierOf(content, rewards, tiers, bands);
    return key && key !== content.tierKey ? { ...content, tierKey: key } : content;
  });
}

/** Priced items sitting outside their band's tier: what a re-sort would move. */
export function handPlacedCount({ tiers, contents }: Tiering, rewards: Rewards, bands: PriceBands) {
  return contents.filter((content) => {
    const key = bandTierOf(content, rewards, tiers, bands);
    return key !== null && key !== content.tierKey;
  }).length;
}

/** The price preset's tiers: a saved tier with a preset's key keeps its id, so saving updates it. */
export function applyPricePreset({ tiers, contents }: Tiering, rewards: Rewards, bands: PriceBands): Tiering {
  const next: DraftTier[] = PRICE_TIERS.map((preset) => ({
    id: tiers.find((tier) => tier.key === preset.key)?.id ?? null,
    key: preset.key,
    name: preset.name,
    weight: preset.weight,
    color: preset.color,
  }));
  return {
    tiers: next,
    contents: contents.map((content) => {
      const key = bandOf(rewards.get(content.rewardDefinitionId)?.shelf ?? null, bands);
      const kept = next.some((tier) => tier.key === content.tierKey) ? content.tierKey : PRICE_TIERS[0].key;
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
export function newTier(tiers: DraftTier[], name: string): DraftTier | string {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the tier a name.';
  const key = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  if (!TIER_KEY_PATTERN.test(key)) return 'Use letters or digits in the name.';
  if (tiers.some((tier) => tier.key === key)) return 'This box already has a tier with that name.';
  return { id: null, key, name: trimmed, weight: 10, color: TIER_COLORS[tiers.length % TIER_COLORS.length] };
}

/* ---------- designs: team variants read as one item ---------- */

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
    const design = reward?.design ?? `#${row.rewardDefinitionId}`;
    // A tier key never holds '|', so the first one splits the id.
    const id = `${row.tierKey}|${design}`;
    const group = groups.get(id);
    if (group) group.rows.push(row);
    else
      groups.set(id, {
        id,
        tierKey: row.tierKey,
        design,
        shelf: reward?.shelf ?? null,
        imageUrl: reward?.imageUrl ?? null,
        rows: [row],
      });
  }
  return [...groups.values()].sort((a, b) => a.design.localeCompare(b.design));
}

/** Where a catalog design stands in the box: which of its variants are in it, and in which tiers. */
export function presenceOf(design: CatalogDesign, byReward: ReadonlyMap<number, DraftContent>) {
  const rows = design.variants.flatMap((variant) => {
    const row = variant.definitionId === null ? undefined : byReward.get(variant.definitionId);
    return row ? [row] : [];
  });
  return { inBox: rows.length, tierKeys: [...new Set(rows.map((row) => row.tierKey))] };
}

/** Adds every variant of the designs that has a definition and isn't in the box, to one tier. */
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

/** Moves the listed rewards' rows to a tier; returns how many moved. */
export function moveRewards(contents: DraftContent[], rewardIds: ReadonlySet<number>, tierKey: string) {
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

/* ---------- odds by team ---------- */

export type TierOdds = {
  tierKey: string;
  name: string;
  color: string | null;
  /** Holds something for this buyer; otherwise the tier drops out of the draw. */
  eligible: boolean;
  share: number;
  each: number;
  count: number;
};
export type TeamOdds = { team: string | null; tiers: TierOdds[]; avgShelf: number };

/**
 * Base odds (nothing owned) per team, through the draw's own `computeBoxOdds` (via `previewOdds`).
 * `avgShelf` is the expected shelf price of one draw: information for pricing, never a price rule.
 */
export function oddsByTeam(draft: Tiering, rewards: Rewards, teams: readonly string[]): TeamOdds[] {
  return (teams.length ? teams : [null]).map((team) => {
    const odds = previewOdds(draft, rewards, team);
    let avgShelf = 0;
    const tiers = draft.tiers.map((tier, index): TierOdds => {
      const found = odds?.tiers.find((entry) => entry.tierId === index);
      if (!found) return { tierKey: tier.key, name: tier.name, color: tier.color, eligible: false, share: 0, each: 0, count: 0 };
      const shelves = found.contentIds.map(
        (contentId) => rewards.get(draft.contents[contentId].rewardDefinitionId)?.shelf ?? 0
      );
      avgShelf += found.probability * (shelves.reduce((sum, value) => sum + value, 0) / shelves.length);
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
    return { team, tiers, avgShelf };
  });
}

/** Teams whose odds match are shown as one column; they split only when something differs. */
export function teamsDiffer(odds: TeamOdds[]): boolean {
  const signature = (entry: TeamOdds) =>
    entry.tiers.map((tier) => `${tier.eligible}:${tier.share.toFixed(9)}:${tier.count}`).join('|') +
    `#${Math.round(entry.avgShelf)}`;
  return odds.some((entry) => signature(entry) !== signature(odds[0]));
}

/* ---------- checklist, in names ---------- */

export type FixTarget = { step: 'basics' | 'items'; tierKey?: string };
export type FlowProblem = { message: string; fix?: FixTarget };
export type FlowNote = { message: string; info?: boolean };

/**
 * The publish checklist for the screen: the problems `boxChecklist` would refuse, named for a moderator
 * (never "Reward #311") with a place to fix each.
 *
 * `boxChecklist` stays the gate, because it is the rule the server enforces on save. This is a second
 * rendering of the same rules for the screen, so a test pins both to the same verdict over every kind of
 * problem. If the gate refuses and none of the named rules did, the gate's own words are shown, so a
 * refusal is never invisible.
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
      : { message: 'No event: buyers have no team, so they draw only cosmetics made for no team.', info: true }
  );

  const tierProblems = problems.length;
  if (!draft.tiers.length) problems.push({ message: 'The box needs at least one tier.', fix: { step: 'items' } });
  const keys = new Set<string>();
  let totalWeight = 0;
  for (const tier of draft.tiers) {
    const label = tier.name.trim() || tier.key || 'A tier';
    const fix: FixTarget = { step: 'items', tierKey: tier.key };
    if (!TIER_KEY_PATTERN.test(tier.key))
      problems.push({ message: `${label}: the key must be 1-32 lowercase letters, digits or dashes.`, fix });
    else if (keys.has(tier.key)) problems.push({ message: `Two tiers share the key "${tier.key}".`, fix });
    keys.add(tier.key);
    if (!tier.name.trim()) problems.push({ message: `Tier "${tier.key}" needs a name.`, fix });
    if (!Number.isSafeInteger(tier.weight) || tier.weight <= 0)
      problems.push({ message: `${label}: the weight must be a whole number above 0.`, fix });
    else totalWeight += tier.weight;
  }
  if (totalWeight > MAX_BOX_WEIGHT)
    problems.push({ message: `The weights add up to ${totalWeight}; the most is ${MAX_BOX_WEIGHT}.`, fix: { step: 'items' } });
  if (draft.tiers.length && problems.length === tierProblems)
    passed.push({ message: `${draft.tiers.length} tier${draft.tiers.length > 1 ? 's' : ''}, weights add up to ${totalWeight}.` });

  const seen = new Set<number>();
  const enabled: { tierKey: string; team: string | null }[] = [];
  for (const content of draft.contents) {
    const name = nameOf(content.rewardDefinitionId);
    const fix: FixTarget = { step: 'items', tierKey: content.tierKey };
    if (seen.has(content.rewardDefinitionId)) problems.push({ message: `${name} is in the box twice.`, fix });
    seen.add(content.rewardDefinitionId);
    if (!keys.has(content.tierKey)) problems.push({ message: `${name} is in a tier the box doesn't have.`, fix });
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
      enabled.filter((content) => isForTeam(content.team ?? undefined, team)).map((content) => content.tierKey)
    );
    for (const tier of draft.tiers)
      if (!inTier.has(tier.key))
        problems.push({
          message: `${tier.name || tier.key} has nothing for ${team === undefined ? 'a buyer with no team' : `team ${team}`}.`,
          fix: { step: 'items', tierKey: tier.key },
        });
  }
  if (draft.tiers.length && problems.length === before)
    passed.push({ message: `Every tier holds something for ${teams.length ? 'every team' : 'a buyer with no team'}.` });
  passed.push({ message: 'Only cosmetics can be picked, and no box can go in a box.', info: true });

  if (!problems.length) {
    const refusals = boxChecklist(draft, rewards, teams);
    for (const message of refusals) problems.push({ message });
  }
  return { problems, passed };
}
