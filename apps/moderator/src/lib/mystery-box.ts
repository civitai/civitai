import { computeBoxOdds, MAX_BOX_WEIGHT, type BoxOdds } from '@civitai/shared/box-odds';
import { isForTeam, ITEM_TYPE } from '@civitai/shared/mystery-box';

export { ITEM_DEFINITION_STATUS, ITEM_TYPE } from '@civitai/shared/mystery-box';

/** What a held box does when nothing in it is left for its holder; `keep` leaves it held. */
export const EMPTY_RULES = ['keep'] as const;

export const TIER_KEY_PATTERN = /^[a-z0-9-]{1,32}$/;

/** A box tier as the editor holds it. Array order is draw order (`sortOrder`). */
export type DraftTier = {
  id: number | null;
  /** Fixed once saved: the odds history names tiers by key. */
  key: string;
  name: string;
  weight: number;
  color: string | null;
};

export type DraftContent = {
  id: number | null;
  rewardDefinitionId: number;
  tierKey: string;
  enabled: boolean;
};

export type BoxArt = Record<string, { closed?: string; open?: string }>;

export type BoxDraft = {
  name: string;
  description: string;
  imageUrl: string;
  event: string;
  emptyRule: (typeof EMPTY_RULES)[number];
  art: BoxArt;
  tiers: DraftTier[];
  contents: DraftContent[];
};

export type RewardInfo = {
  id: number;
  type: string;
  name: string;
  cosmeticId: number | null;
  /** The cosmetic's `data.team`; a cosmetic with none goes to every team. */
  team: string | null;
  imageUrl: string | null;
};

/**
 * Why this box can't be published (or, once published, saved); empty when it can. A buyer draws only
 * cosmetics made for their team or for no team, and a buyer with no team (no event, or an event whose
 * cosmetics name no team) has `teams = []`. So every tier needs something for every team (or, with
 * none, something made for no team), and a cosmetic made for a team nobody is on is refused.
 */
export function boxChecklist(
  draft: Pick<BoxDraft, 'name' | 'tiers' | 'contents'>,
  rewards: ReadonlyMap<number, Pick<RewardInfo, 'type' | 'team'>>,
  teams: readonly string[]
): string[] {
  const problems: string[] = [];
  if (!draft.name.trim()) problems.push('The box needs a name.');
  if (!draft.tiers.length) problems.push('The box needs at least one tier.');

  const keys = new Set<string>();
  let totalWeight = 0;
  for (const tier of draft.tiers) {
    const label = tier.name.trim() || tier.key || 'A tier';
    if (!TIER_KEY_PATTERN.test(tier.key))
      problems.push(`${label}: the key must be 1-32 lowercase letters, digits or dashes.`);
    else if (keys.has(tier.key)) problems.push(`Two tiers share the key "${tier.key}".`);
    keys.add(tier.key);
    if (!tier.name.trim()) problems.push(`Tier "${tier.key}" needs a name.`);
    if (!Number.isSafeInteger(tier.weight) || tier.weight <= 0)
      problems.push(`${label}: the weight must be a whole number above 0.`);
    else totalWeight += tier.weight;
  }
  if (totalWeight > MAX_BOX_WEIGHT)
    problems.push(`The weights add up to ${totalWeight}; the most is ${MAX_BOX_WEIGHT}.`);

  const seen = new Set<number>();
  const enabled: { tierKey: string; team: string | null }[] = [];
  for (const content of draft.contents) {
    if (seen.has(content.rewardDefinitionId))
      problems.push(`Reward #${content.rewardDefinitionId} is in the box twice.`);
    seen.add(content.rewardDefinitionId);
    if (!keys.has(content.tierKey))
      problems.push(`Reward #${content.rewardDefinitionId} is in a tier the box doesn't have.`);
    if (!content.enabled) continue;
    const reward = rewards.get(content.rewardDefinitionId);
    if (!reward) {
      problems.push(`Reward #${content.rewardDefinitionId} doesn't exist.`);
      continue;
    }
    if (reward.type === ITEM_TYPE.box) {
      problems.push(`Reward #${content.rewardDefinitionId} is a box; a box can't hold a box.`);
      continue;
    }
    if (reward.type !== ITEM_TYPE.cosmetic) {
      problems.push(
        `Reward #${content.rewardDefinitionId} isn't a cosmetic; boxes hold cosmetics only.`
      );
      continue;
    }
    if (reward.team !== null && !teams.includes(reward.team))
      problems.push(
        teams.length
          ? `Reward #${content.rewardDefinitionId} is made for team ${reward.team}, which isn't one of this event's teams.`
          : `Reward #${content.rewardDefinitionId} is made for team ${reward.team}, but this box's buyers have no team, so nobody can draw it.`
      );
    enabled.push({ tierKey: content.tierKey, team: reward.team });
  }

  // No teams: the buyer has no team and draws only cosmetics made for no team.
  for (const team of teams.length ? teams : [undefined]) {
    const inTier = new Set(
      enabled
        .filter((content) => isForTeam(content.team ?? undefined, team))
        .map((content) => content.tierKey)
    );
    for (const tier of draft.tiers)
      if (!inTier.has(tier.key))
        problems.push(
          team === undefined
            ? `${tier.name || tier.key} has nothing in it.`
            : `${tier.name || tier.key} has nothing for team ${team}.`
        );
  }
  return problems;
}

/**
 * Base odds (nothing owned) for one team, through the draw's own `computeBoxOdds`. Ids are positions
 * in the draft, so unsaved rows preview too. Null when the weights can't be computed.
 */
export function previewOdds(
  draft: Pick<BoxDraft, 'tiers' | 'contents'>,
  rewards: ReadonlyMap<number, Pick<RewardInfo, 'type' | 'team'>>,
  team: string | null
): BoxOdds | null {
  const tierIndex = new Map(draft.tiers.map((tier, i) => [tier.key, i]));
  const pool = draft.contents.flatMap((content, i) => {
    const reward = rewards.get(content.rewardDefinitionId);
    const tierId = tierIndex.get(content.tierKey);
    if (!content.enabled || !reward || reward.type !== ITEM_TYPE.cosmetic || tierId === undefined)
      return [];
    if (!isForTeam(reward.team ?? undefined, team ?? undefined)) return [];
    return [{ contentId: i, tierId }];
  });
  try {
    return computeBoxOdds(
      draft.tiers.map((tier, i) => ({ id: i, weight: tier.weight, sortOrder: i })),
      pool
    );
  } catch {
    return null;
  }
}
