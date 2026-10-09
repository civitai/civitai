import { IconShare3 } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import type { ScoreTierSlug } from '~/shared/constants/creator-journey.constants';
import { milestoneShareHref } from '~/shared/constants/creator-journey.constants';

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
    <ShareButton
      url={milestoneShareHref(username, slug)}
      title={`I reached ${tierName} on Civitai`}
    >
      <LegacyActionIcon radius="xl" aria-label={`Share ${tierName}`}>
        <IconShare3 size={16} />
      </LegacyActionIcon>
    </ShareButton>
  );
}
