import {
  IconBraces,
  IconChartBar,
  IconCompass,
  IconDeviceGamepad2,
  IconShieldHalf,
  IconSparkles,
  IconTool,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import type { MarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';

/**
 * Per-category Tabler icon for the marketplace category controls.
 *
 * This mirrors the icon mapping the card chip uses (`CATEGORY_ICONS` in
 * `AppBlockCard.tsx`, added with the card-chip pass) so the icon-toggle filter
 * buttons and the card chip stay visually consistent. It lives in its own module
 * (rather than re-importing the card's private map) so the filter-button control
 * can reuse it without coupling to the card component.
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
