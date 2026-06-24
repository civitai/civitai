import {
  IconBraces,
  IconChartBar,
  IconCompass,
  IconDeviceGamepad2,
  IconShieldHalf,
  IconSparkles,
  IconTag,
  IconTool,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import type { MarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';

/**
 * Per-category Tabler icon for the marketplace category controls.
 *
 * SINGLE SOURCE OF TRUTH for the category→icon mapping. Both the marketplace
 * card chip (`AppBlockCard.tsx`) and the icon-toggle filter buttons
 * (`CategoryFilterButtons.tsx`) import `CATEGORY_ICONS` from here so the icon
 * for a given category is defined exactly once and stays consistent across the
 * two surfaces. It lives in its own module (rather than the card owning a
 * private copy) so the filter-button control can reuse it without coupling to
 * the card component.
 */
export const CATEGORY_ICONS: Record<MarketplaceCategory, Icon> = {
  generation: IconSparkles,
  games: IconDeviceGamepad2,
  utility: IconTool,
  discovery: IconCompass,
  moderation: IconShieldHalf,
  analytics: IconChartBar,
  other: IconBraces,
};

/**
 * Generic fallback icon for a category value that is NOT in `CATEGORY_ICONS`
 * (an unknown/legacy `app_blocks.category`, or a category added to
 * `MARKETPLACE_CATEGORIES` but not yet given an icon here). Renders a neutral
 * tag rather than crashing the chip / filter row.
 */
export const FALLBACK_CATEGORY_ICON: Icon = IconTag;
