import type { Icon, IconProps } from '@tabler/icons-react';
import { IconBox, IconShirt, IconSparkles, IconStar, IconUsers } from '@tabler/icons-react';
import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import type { CreatorShopSectionKey } from '~/server/schema/creator-shop.schema';

export type TablerIcon = ForwardRefExoticComponent<Omit<IconProps, 'ref'> & RefAttributes<Icon>>;

// Canonical per-section icons, shared by the settings modal and the storefront
// section headers so the two never drift.
export const sectionIcons: Record<CreatorShopSectionKey, TablerIcon> = {
  featured: IconStar,
  cosmetics: IconSparkles,
  resold: IconUsers,
  merch: IconShirt,
  models: IconBox,
};
