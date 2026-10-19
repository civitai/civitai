import type { Icon, IconProps } from '@tabler/icons-react';
import {
  IconBox,
  IconFrame,
  IconHanger,
  IconPhoto,
  IconRosette,
  IconSignature,
  IconSparkles,
  IconSticker,
  IconUserCircle,
} from '@tabler/icons-react';
import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import {
  equippableOf,
  framesOf,
  hatsOf,
  stickersOf,
  useInventoryCosmeticCount,
} from '~/components/Inventory/inventory-cosmetics';
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

const mysteryBoxGate = (features: FeatureAccess) => !!features.mysteryBox;

export const INVENTORY_TYPES = [
  {
    key: 'boxes',
    label: 'Boxes',
    icon: IconBox,
    enabled: mysteryBoxGate,
    useCount: () => useQueryNotificationsCount().unopenedBoxes,
  },
  {
    key: 'hats',
    label: 'Hats',
    icon: IconHanger,
    enabled: mysteryBoxGate,
    useCount: () => useInventoryCosmeticCount((data) => hatsOf(data).length),
  },
  {
    key: 'badges',
    label: 'Badges',
    icon: IconRosette,
    enabled: mysteryBoxGate,
    useCount: () => useInventoryCosmeticCount((data) => equippableOf(data, 'badges').length),
  },
  {
    key: 'avatar-decorations',
    label: 'Avatar decorations',
    icon: IconUserCircle,
    enabled: mysteryBoxGate,
    useCount: () =>
      useInventoryCosmeticCount((data) => equippableOf(data, 'avatar-decorations').length),
  },
  {
    key: 'nameplates',
    label: 'Nameplates',
    icon: IconSignature,
    enabled: mysteryBoxGate,
    useCount: () => useInventoryCosmeticCount((data) => equippableOf(data, 'nameplates').length),
  },
  {
    key: 'backgrounds',
    label: 'Profile backgrounds',
    icon: IconPhoto,
    enabled: mysteryBoxGate,
    useCount: () => useInventoryCosmeticCount((data) => equippableOf(data, 'backgrounds').length),
  },
  {
    key: 'card-glows',
    label: 'Card glows',
    icon: IconSparkles,
    enabled: mysteryBoxGate,
    useCount: () => useInventoryCosmeticCount((data) => equippableOf(data, 'card-glows').length),
  },
  {
    key: 'frames',
    label: 'Content frames',
    icon: IconFrame,
    enabled: mysteryBoxGate,
    useCount: () => useInventoryCosmeticCount((data) => framesOf(data).length),
  },
  {
    key: 'stickers',
    label: 'Stickers',
    icon: IconSticker,
    enabled: mysteryBoxGate,
    useCount: () => useInventoryCosmeticCount((data) => stickersOf(data).length),
  },
] as const satisfies readonly InventoryType[];

export type InventoryTypeKey = (typeof INVENTORY_TYPES)[number]['key'];

export function enabledInventoryTypes(features: FeatureAccess | null | undefined) {
  return features ? INVENTORY_TYPES.filter((type) => type.enabled(features)) : [];
}
