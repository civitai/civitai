import type { ReactionMetrics } from '~/components/Reaction/Reactions';
import type { ImageV2Stats } from '~/server/selectors/imagev2.selector';

export type ImageReactionStats = Partial<
  Pick<
    ImageV2Stats,
    | 'likeCountAllTime'
    | 'dislikeCountAllTime'
    | 'heartCountAllTime'
    | 'laughCountAllTime'
    | 'cryCountAllTime'
    | 'tippedAmountCountAllTime'
  >
>;

/**
 * An image's `stats` as the counts `<Reactions>` and `<Metrics initial>` draw. Every image card
 * builds them here: a card that listed the fields by hand and left out `tippedAmountCount` drew a
 * 0 Buzz tip badge on an image with tips, while its reaction counts stayed right.
 */
export function imageStatsToReactionMetrics(
  stats: ImageReactionStats | null | undefined
): Required<ReactionMetrics> {
  return {
    likeCount: stats?.likeCountAllTime ?? 0,
    dislikeCount: stats?.dislikeCountAllTime ?? 0,
    heartCount: stats?.heartCountAllTime ?? 0,
    laughCount: stats?.laughCountAllTime ?? 0,
    cryCount: stats?.cryCountAllTime ?? 0,
    tippedAmountCount: stats?.tippedAmountCountAllTime ?? 0,
  };
}
