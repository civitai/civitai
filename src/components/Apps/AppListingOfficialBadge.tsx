import { IconRosetteDiscountCheck } from '@tabler/icons-react';

import { IconBadge } from '~/components/IconBadge/IconBadge';

/**
 * The marker on an app made by the Civitai team, on the store card and the app page.
 *
 * Driven by `ListingCard.isOfficial` / `ListingDetail.isOfficial` — a column only a moderator
 * can set (`appListings.setListingOfficial`, on `moderatorProcedure`). It is a provenance
 * claim, so render it from that flag and nothing else: never from the app's name, category or
 * anything its author controls.
 *
 * Same icon, colour and wording as `OfficialArticleBadge`, so one provenance concept looks the
 * same on every surface. One component for both store surfaces so the two cannot drift.
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
