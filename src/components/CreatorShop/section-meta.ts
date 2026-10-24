import type { Icon, IconProps } from '@tabler/icons-react';
import {
  IconBox,
  IconBriefcase,
  IconShirt,
  IconSparkles,
  IconStar,
  IconUsers,
} from '@tabler/icons-react';
import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import type { CreatorShopSectionKey } from '~/server/schema/creator-shop.schema';
import { creatorShopSectionKeys } from '~/server/schema/creator-shop.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

export type TablerIcon = ForwardRefExoticComponent<Omit<IconProps, 'ref'> & RefAttributes<Icon>>;

// Canonical per-section icons, shared by the settings modal and the storefront
// section headers so the two never drift.
export const sectionIcons: Record<CreatorShopSectionKey, TablerIcon> = {
  featured: IconStar,
  cosmetics: IconSparkles,
  resold: IconUsers,
  services: IconBriefcase,
  merch: IconShirt,
  models: IconBox,
};

const sectionFlags: Partial<Record<CreatorShopSectionKey, keyof FeatureAccess>> = {
  services: 'creatorServices',
};

export const isSectionAvailable = (key: CreatorShopSectionKey, features: FeatureAccess) => {
  const flag = sectionFlags[key];
  return !flag || features[flag];
};

type SectionSetting = { key: CreatorShopSectionKey; visible: boolean };

/** The saved order with any section added since it was saved appended, visible. */
export function withMissingSections(saved?: SectionSetting[] | null): SectionSetting[] {
  const ordered = (saved ?? []).map((s) => ({ key: s.key, visible: s.visible }));
  for (const key of creatorShopSectionKeys)
    if (!ordered.some((s) => s.key === key)) ordered.push({ key, visible: true });
  return ordered;
}

/** The sections a storefront renders, in order: visible in the saved settings and switched on. */
export const storefrontSectionKeys = (
  saved: SectionSetting[] | null | undefined,
  features: FeatureAccess
): CreatorShopSectionKey[] =>
  withMissingSections(saved)
    .filter((s) => s.visible && isSectionAvailable(s.key, features))
    .map((s) => s.key);

/** The storefront section's element id, so a link can jump to it. */
export const storefrontSectionId = (key: CreatorShopSectionKey) => `shop-${key}`;
