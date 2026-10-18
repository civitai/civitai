import type { Icon, IconProps } from '@tabler/icons-react';
import { IconBox } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import type { ComponentType, ForwardRefExoticComponent, RefAttributes } from 'react';
import { useQueryNotificationsCount } from '~/components/Notifications/notifications.utils';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

// Pages load on their own route only: the user menu reads this list on every page.
const InventoryBoxes = dynamic(() =>
  import('~/components/Inventory/InventoryBoxes').then((m) => m.InventoryBoxes)
);

/**
 * One kind of thing a user can own, with its own page under /user/inventory/<key>. A new kind
 * (faction tokens, perks, passes) is one entry here and its page.
 */
export type InventoryType = {
  key: string;
  label: string;
  icon: ForwardRefExoticComponent<IconProps & RefAttributes<Icon>>;
  /** Whether this viewer can have this kind of thing at all. */
  enabled: (features: FeatureAccess) => boolean;
  /** How many the viewer has, for the nav. Must not cost a request the page does not make anyway. */
  useCount: () => number | undefined;
  Page: ComponentType;
};

export const INVENTORY_TYPES: InventoryType[] = [
  {
    key: 'boxes',
    label: 'Boxes',
    icon: IconBox,
    enabled: (features) => !!features.mysteryBox,
    useCount: () => useQueryNotificationsCount().unopenedBoxes,
    Page: InventoryBoxes,
  },
];

export function enabledInventoryTypes(features: FeatureAccess | null | undefined) {
  return features ? INVENTORY_TYPES.filter((type) => type.enabled(features)) : [];
}
