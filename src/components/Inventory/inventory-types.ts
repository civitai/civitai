import type { Icon, IconProps } from '@tabler/icons-react';
import { IconBox } from '@tabler/icons-react';
import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import { useQueryNotificationsCount } from '~/components/Notifications/notifications.utils';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

/**
 * One kind of thing a user can own, with its own page under /user/inventory/<key> (`INVENTORY_PAGES`).
 * No page code here: the user menu reads this list on every page.
 */
export type InventoryType = {
  key: string;
  label: string;
  icon: ForwardRefExoticComponent<IconProps & RefAttributes<Icon>>;
  enabled: (features: FeatureAccess) => boolean;
  /** How many the viewer has, for the nav. Must not cost a request the page does not make anyway. */
  useCount: () => number | undefined;
};

export const INVENTORY_TYPES = [
  {
    key: 'boxes',
    label: 'Boxes',
    icon: IconBox,
    enabled: (features) => !!features.mysteryBox,
    useCount: () => useQueryNotificationsCount().unopenedBoxes,
  },
] as const satisfies readonly InventoryType[];

export type InventoryTypeKey = (typeof INVENTORY_TYPES)[number]['key'];

export function enabledInventoryTypes(features: FeatureAccess | null | undefined) {
  return features ? INVENTORY_TYPES.filter((type) => type.enabled(features)) : [];
}
