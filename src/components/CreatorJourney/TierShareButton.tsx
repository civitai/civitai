import { IconShare3 } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import type { ScoreTierSlug } from '~/shared/constants/creator-journey.constants';
import { SCORE_TIERS, scoreTierKey } from '~/shared/constants/creator-journey.constants';

export const scoreTierSlugOf = (key: string) =>
  SCORE_TIERS.find((tier) => scoreTierKey(tier.slug) === key)?.slug ?? null;

/** The profile link whose preview swaps to this tier's card; see `milestoneOgEndpoint`. */
export const tierShareUrl = (username: string, slug: ScoreTierSlug) =>
  `/user/${encodeURIComponent(username)}?milestone=${slug}`;

/** Only offered for a tier whose share card renders: anything else would preview the bare profile. */
export function TierShareButton({
  username,
  slug,
  tierName,
}: {
  username: string;
  slug: ScoreTierSlug;
  tierName: string;
}) {
  return (
    <ShareButton url={tierShareUrl(username, slug)} title={`I reached ${tierName} on Civitai`}>
      <LegacyActionIcon radius="xl" aria-label={`Share ${tierName}`}>
        <IconShare3 size={16} />
      </LegacyActionIcon>
    </ShareButton>
  );
}
