/**
 * The mystery box builder's save rules, apart from any database client: the publish checklist, the
 * check that a draft fits the box's saved rows, and the plan of which rows a save inserts, updates
 * and deletes. The moderator builder runs them on Kysely; a creator box's approval runs them too, so
 * both save a box the same way.
 */
import { MAX_BOX_WEIGHT } from './box-odds';
import { snapshotsMatch, type BoxOddsSnapshotData } from './box-odds-snapshot';
import { isForTeam, ITEM_TYPE } from './mystery-box';

/** A refusal the moderator can act on. Thrown before anything commits; the action answers 409. */
export class BoxRefusal extends Error {}

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

/** `ItemDefinition.params` of a box. */
export type BoxParams = Record<string, unknown> & {
  event?: unknown;
  emptyRule?: unknown;
  art?: unknown;
};

/** The box's event (`params.event`), or null. */
export const boxEventOf = (params: BoxParams) =>
  typeof params.event === 'string' ? params.event : null;

/** The params a save writes: the draft's event, empty rule and art over whatever else is there. */
export function boxParamsForSave(
  params: BoxParams,
  draft: Pick<BoxDraft, 'event' | 'emptyRule' | 'art'>
) {
  const event = draft.event.trim() || null;
  const { event: _event, ...rest } = params;
  return {
    event,
    params: { ...rest, ...(event ? { event } : {}), emptyRule: draft.emptyRule, art: draft.art },
  };
}

export type BoxTierRow = {
  id: number;
  key: string;
  name: string;
  weight: number;
  color: string | null;
  sortOrder: number;
};
export type BoxContentRow = {
  id: number;
  rewardDefinitionId: number;
  tierId: number;
  enabled: boolean;
};

/** Refuses a draft that doesn't fit the box's saved rows. Runs before the save writes anything. */
export function assertDraftFitsRows(
  draft: Pick<BoxDraft, 'tiers' | 'contents'>,
  tiers: readonly BoxTierRow[],
  contents: readonly BoxContentRow[]
) {
  const tierById = new Map(tiers.map((tier) => [tier.id, tier]));
  const contentById = new Map(contents.map((content) => [content.id, content]));

  const keys = new Set<string>();
  for (const tier of draft.tiers) {
    if (keys.has(tier.key)) throw new BoxRefusal(`Two tiers share the key "${tier.key}".`);
    keys.add(tier.key);
    if (tier.id === null) {
      if (tiers.some((existing) => existing.key === tier.key))
        throw new BoxRefusal(`The key "${tier.key}" is already used by a tier of this box.`);
      continue;
    }
    const existing = tierById.get(tier.id);
    if (!existing) throw new BoxRefusal(`Tier #${tier.id} isn't in this box.`);
    if (existing.key !== tier.key)
      throw new BoxRefusal(`Tier "${existing.key}" can't change its key once saved.`);
  }
  const contentIds = new Set<number>();
  for (const content of draft.contents) {
    if (content.id === null) continue;
    if (!contentById.has(content.id))
      throw new BoxRefusal(`Content #${content.id} isn't in this box.`);
    // UPDATE … FROM VALUES applies only one of several rows for the same id, and which is unspecified.
    if (contentIds.has(content.id))
      throw new BoxRefusal(`Content #${content.id} is in the box twice.`);
    contentIds.add(content.id);
  }
}

/** The saved contents the draft keeps; every other content of the box is deleted. */
export const keptContentIds = (draft: Pick<BoxDraft, 'contents'>) =>
  draft.contents.flatMap((content) => (content.id ? [content.id] : []));

/**
 * The tier rows to insert and to update (only those that changed), and the ids of the kept tiers by
 * key; `tierIdsWithInserted` adds the new tiers' ids once they are inserted. Assumes
 * `assertDraftFitsRows` passed.
 */
export function planTierWrites(
  boxId: number,
  draft: Pick<BoxDraft, 'tiers'>,
  tiers: readonly BoxTierRow[]
) {
  const tierById = new Map(tiers.map((tier) => [tier.id, tier]));
  const tierIdByKey = new Map<string, number>();
  const newTiers = [];
  const changedTiers = [];
  for (const [sortOrder, tier] of draft.tiers.entries()) {
    const values = { name: tier.name.trim(), weight: tier.weight, color: tier.color, sortOrder };
    if (tier.id === null) {
      newTiers.push({ boxDefinitionId: boxId, key: tier.key, ...values });
      continue;
    }
    tierIdByKey.set(tier.key, tier.id);
    const existing = tierById.get(tier.id)!;
    if (
      existing.name !== values.name ||
      existing.weight !== values.weight ||
      existing.color !== values.color ||
      existing.sortOrder !== values.sortOrder
    )
      changedTiers.push({ id: tier.id, ...values });
  }
  return { newTiers, changedTiers, tierIdByKey };
}

/**
 * The kept tiers' ids plus the inserted ones, by key. The save deletes every tier missing from this
 * map, so a new tier with no contents that was left out would vanish silently.
 */
export function tierIdsWithInserted(
  plan: Pick<ReturnType<typeof planTierWrites>, 'newTiers' | 'tierIdByKey'>,
  inserted: readonly { id: number; key: string }[]
) {
  const tierIdByKey = new Map(plan.tierIdByKey);
  for (const row of inserted) tierIdByKey.set(row.key, row.id);
  for (const tier of plan.newTiers)
    if (!tierIdByKey.has(tier.key))
      throw new Error(`The tier insert returned no id for "${tier.key}".`);
  return tierIdByKey;
}

/**
 * The content rows to insert and to update (only those that changed), once every tier has an id.
 * Assumes `assertDraftFitsRows` passed.
 */
export function planContentWrites(
  boxId: number,
  draft: Pick<BoxDraft, 'contents'>,
  contents: readonly BoxContentRow[],
  tierIdByKey: ReadonlyMap<string, number>
) {
  const contentById = new Map(contents.map((content) => [content.id, content]));
  const newContents = [];
  const changedContents = [];
  for (const content of draft.contents) {
    const tierId = tierIdByKey.get(content.tierKey);
    if (tierId === undefined)
      throw new BoxRefusal(
        `Reward #${content.rewardDefinitionId} is in a tier the box doesn't have.`
      );
    if (content.id === null) {
      newContents.push({
        boxDefinitionId: boxId,
        tierId,
        rewardDefinitionId: content.rewardDefinitionId,
        enabled: content.enabled,
      });
      continue;
    }
    const existing = contentById.get(content.id)!;
    if (existing.tierId !== tierId || existing.enabled !== content.enabled)
      changedContents.push({ id: content.id, tierId, enabled: content.enabled });
  }
  return { newContents, changedContents };
}

type BoxOddsState = { snapshot: BoxOddsSnapshotData; event: string | null };

/**
 * Whether the odds snapshot or the event differs. The event is outside the snapshot but decides the
 * buyers' teams.
 */
export const oddsChanged = (before: BoxOddsState, after: BoxOddsState) =>
  !snapshotsMatch(before.snapshot, after.snapshot) || before.event !== after.event;
