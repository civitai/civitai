import { computeBoxOdds, type BoxOdds } from '@civitai/shared/box-odds';
import type { BoxDraft, RewardInfo } from '@civitai/shared/box-builder';
import { isForTeam, ITEM_TYPE } from '@civitai/shared/mystery-box';

export { ITEM_DEFINITION_STATUS, ITEM_TYPE } from '@civitai/shared/mystery-box';
export {
  boxChecklist,
  EMPTY_RULES,
  TIER_KEY_PATTERN,
  type BoxArt,
  type BoxDraft,
  type DraftContent,
  type DraftTier,
  type RewardInfo,
} from '@civitai/shared/box-builder';

export const MAX_BOXES_PER_USER = 10;
export const MAX_GRANT_USERS = 500;

/**
 * A fresh id for one box-grant form. Resubmitting the same form reuses it, so the second grants
 * nothing (`modGrantSourceKey`). Alphanumeric, as the key requires.
 */
export function newBoxGrantId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Entries are not validated. */
export const parseUserIdList = (value: string) => [
  ...new Set(value.split(/[\s,]+/).filter(Boolean)),
];

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
