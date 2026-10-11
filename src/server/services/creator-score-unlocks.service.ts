import {
  CREATOR_PROGRAM_MIN_CREATOR_SCORE,
  minCreatorScoreForSale,
  MONETIZATION_MIN_CREATOR_SCORE,
  parseSaleLimitOverrides,
  SALE_LIMITS_KEY,
} from '@civitai/buzz';
import { EARLY_ACCESS_CONFIG } from '~/server/common/constants';
import { scoreRungs } from '~/server/utils/early-access-helpers';
import { dbRead } from '~/server/db/client';
import { dailyArticleTiers } from '~/server/schema/article.schema';
import { COMMENT_RATE_LIMIT_MIN_CREATOR_SCORE } from '~/server/schema/comment.schema';
import { dailyPostTiers, MEMBER_DAILY_POST_MULTIPLIER } from '~/server/schema/post.schema';
import { REACTION_RATE_LIMIT_MIN_CREATOR_SCORE } from '~/server/schema/reaction.schema';
import {
  ANNOUNCEMENT_DEFAULT_MIN_SCORE,
  getAnnouncementMinScore,
} from '~/server/services/announcement-allowance.service';
import { getPlacementConfig } from '~/server/services/placement.service';
import { CHALLENGE_MIN_CREATOR_SCORE } from '~/shared/constants/challenge.constants';
import { CRUCIBLE_JUDGE_MIN_CREATOR_SCORE } from '~/shared/constants/crucible.constants';
import type { CreatorScoreUnlock } from '~/shared/utils/creator-score-unlocks';
import type { PlacementPriceTier, PlacementSurface } from '~/shared/utils/placement';
import {
  PLACEMENT_FREE_SLOT_CAP_TIERS,
  PLACEMENT_PRICE_CAP_TIERS,
  placementSurfaceLabel,
  placementSurfaces,
} from '~/shared/utils/placement';

export type CreatorScoreUnlockInputs = {
  saleMinScore: number;
  announcementMinScore: number;
  placementPriceCapTiers: (surface: PlacementSurface) => PlacementPriceTier[];
  placementFreeSlotTiers: (surface: PlacementSurface) => PlacementPriceTier[];
};

export const compiledCreatorScoreUnlockInputs: CreatorScoreUnlockInputs = {
  saleMinScore: minCreatorScoreForSale(),
  announcementMinScore: ANNOUNCEMENT_DEFAULT_MIN_SCORE,
  placementPriceCapTiers: () => PLACEMENT_PRICE_CAP_TIERS,
  placementFreeSlotTiers: () => PLACEMENT_FREE_SLOT_CAP_TIERS,
};

/** Every privilege a Creator Score unlocks, lowest first. A threshold of 0 is not an unlock. */
export function buildCreatorScoreUnlocks(inputs: CreatorScoreUnlockInputs): CreatorScoreUnlock[] {
  const unlocks: CreatorScoreUnlock[] = [
    {
      key: 'crucible-judge',
      minScore: CRUCIBLE_JUDGE_MIN_CREATOR_SCORE,
      label: 'Judge crucibles',
      surface: 'crucibles',
      scoreKind: 'total',
      source: 'compiled',
    },
    ...dailyPostTiers.map(
      ({ minScore, limit }): CreatorScoreUnlock => ({
        key: `daily-posts:${minScore}`,
        minScore,
        label: `Post up to ${limit} times a day (${
          limit * MEMBER_DAILY_POST_MULTIPLIER
        } as a member)`,
        surface: 'posting',
        scoreKind: 'total',
        source: 'compiled',
      })
    ),
    {
      key: 'comment-rate-limit',
      minScore: COMMENT_RATE_LIMIT_MIN_CREATOR_SCORE,
      label: 'Higher comment limits',
      surface: 'comments',
      scoreKind: 'total',
      source: 'compiled',
    },
    {
      key: 'reaction-rate-limit',
      minScore: REACTION_RATE_LIMIT_MIN_CREATOR_SCORE,
      label: 'Higher reaction limits',
      surface: 'reactions',
      scoreKind: 'total',
      source: 'compiled',
    },
    ...dailyArticleTiers.map(
      ({ minScore, limit }): CreatorScoreUnlock => ({
        key: `daily-articles:${minScore}`,
        minScore,
        label: `Publish up to ${limit} articles a day`,
        surface: 'articles',
        scoreKind: 'total',
        source: 'compiled',
      })
    ),
    {
      key: 'challenge-create',
      minScore: CHALLENGE_MIN_CREATOR_SCORE,
      label: 'Create challenges and crucibles',
      surface: 'challenges',
      scoreKind: 'total',
      source: 'compiled',
    },
    {
      key: 'monetize-pricing',
      minScore: MONETIZATION_MIN_CREATOR_SCORE,
      label: 'Charge for access to your model versions',
      surface: 'monetization',
      scoreKind: 'total',
      source: 'compiled',
    },
    {
      key: 'monetize-sales',
      minScore: inputs.saleMinScore,
      label: 'Run sales on your model versions',
      surface: 'monetization',
      scoreKind: 'total',
      source: 'keyValue',
    },
    ...scoreRungs(EARLY_ACCESS_CONFIG.scoreTimeFrameUnlock).map(
      ([minScore, days]): CreatorScoreUnlock => ({
        key: `early-access-days:${minScore}`,
        minScore,
        label: `Early access for up to ${days} days`,
        surface: 'earlyAccess',
        scoreKind: 'total',
        source: 'compiled',
      })
    ),
    ...scoreRungs(EARLY_ACCESS_CONFIG.scoreQuantityUnlock).map(
      ([minScore, count]): CreatorScoreUnlock => ({
        key: `early-access-quantity:${minScore}`,
        minScore,
        label:
          count === 1
            ? 'One version in early access at a time'
            : `${count} versions in early access at once`,
        surface: 'earlyAccess',
        scoreKind: 'total',
        source: 'compiled',
      })
    ),
    {
      key: 'announcements',
      minScore: inputs.announcementMinScore,
      label: 'Post creator announcements',
      surface: 'announcements',
      scoreKind: 'aggregate',
      source: 'keyValue',
    },
    ...placementSurfaces.flatMap((surface) => [
      ...inputs.placementPriceCapTiers(surface).map(
        ({ minScore }): CreatorScoreUnlock => ({
          key: `placement-price-cap:${surface}:${minScore}`,
          minScore,
          label: `Higher price cap on ${placementSurfaceLabel(surface)}`,
          surface: 'placements',
          scoreKind: 'total',
          source: 'keyValue',
        })
      ),
      ...inputs.placementFreeSlotTiers(surface).map(
        ({ minScore }): CreatorScoreUnlock => ({
          key: `placement-free-slots:${surface}:${minScore}`,
          minScore,
          label: `More free placements on ${placementSurfaceLabel(surface)}`,
          surface: 'placements',
          scoreKind: 'total',
          source: 'keyValue',
        })
      ),
    ]),
    {
      key: 'creator-program',
      minScore: CREATOR_PROGRAM_MIN_CREATOR_SCORE,
      label: 'Join the Creator Program',
      surface: 'creatorProgram',
      scoreKind: 'aggregate',
      source: 'compiled',
    },
  ];

  return unlocks.filter((unlock) => unlock.minScore > 0).sort((a, b) => a.minScore - b.minScore);
}

async function getSaleMinScore() {
  try {
    const row = await dbRead.keyValue.findUnique({ where: { key: SALE_LIMITS_KEY } });
    return minCreatorScoreForSale(row ? parseSaleLimitOverrides(row.value) : undefined);
  } catch {
    return minCreatorScoreForSale();
  }
}

/** The unlocks as the gates enforce them right now, KeyValue overrides included. */
export async function getCreatorScoreUnlocks(): Promise<CreatorScoreUnlock[]> {
  const [saleMinScore, announcementMinScore, placementConfig] = await Promise.all([
    getSaleMinScore(),
    getAnnouncementMinScore(),
    getPlacementConfig(),
  ]);

  return buildCreatorScoreUnlocks({
    saleMinScore,
    announcementMinScore,
    placementPriceCapTiers: placementConfig.priceCapTiers,
    placementFreeSlotTiers: placementConfig.freeSlotTiers,
  });
}
