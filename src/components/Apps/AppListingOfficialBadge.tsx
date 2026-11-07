import { IconRosetteDiscountCheck } from '@tabler/icons-react';

import { IconBadge } from '~/components/IconBadge/IconBadge';

/**
 * Render only from the moderator-set isOfficial flag, never from the name, category or anything
 * the author controls. Matches OfficialArticleBadge.
 */
export function AppListingOfficialBadge({ size = 'sm' }: { size?: 'xs' | 'sm' }) {
  return (
    <IconBadge
      color="blue"
      variant="filled"
      size={size}
      tooltip="Made by Civitai"
      icon={<IconRosetteDiscountCheck size={size === 'xs' ? 12 : 14} stroke={2.5} />}
      style={{ flexShrink: 0 }}
      data-testid="apps-listing-official-badge"
    >
      Official
    </IconBadge>
  );
}
