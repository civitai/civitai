import { Chip, Group } from '@mantine/core';
import { IconApps, IconExternalLink } from '@tabler/icons-react';
import { FilterChip } from '~/components/Filters/FilterChip';
import { CATEGORY_ICONS, FALLBACK_CATEGORY_ICON } from '~/components/Apps/marketplaceCategoryIcons';
import {
  APPS_STORE_KIND_CHIPS,
  kindChipsOn,
  kindFromChips,
} from '~/components/Apps/appsStoreKindChips';
import { LISTING_KIND_LABELS } from '~/components/Apps/listingKindLabels';
import type { ListingKindFilter } from '~/server/schema/blocks/app-listing-read.schema';
import {
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_LABELS,
  type MarketplaceCategory,
} from '~/server/services/blocks/marketplace-categories.constants';

const KIND_ICONS = { onsite: IconApps, offsite: IconExternalLink } as const;

/**
 * The store's Type filter as chips, like the other feeds' filter panels: Embedded and Standalone,
 * both off by default: nothing picked, or both picked, shows every app.
 */
export function KindFilterChips({
  value,
  onChange,
}: {
  value: ListingKindFilter;
  onChange: (next: ListingKindFilter) => void;
}) {
  return (
    <Chip.Group multiple value={kindChipsOn(value)} onChange={(on) => onChange(kindFromChips(on))}>
      <Group gap={8} role="group" aria-label="Filter by app kind">
        {APPS_STORE_KIND_CHIPS.map((kind) => {
          const Icon = KIND_ICONS[kind];
          return (
            <FilterChip key={kind} value={kind}>
              <Group gap={4} wrap="nowrap">
                <Icon size={14} />
                {LISTING_KIND_LABELS[kind]}
              </Group>
            </FilterChip>
          );
        })}
      </Group>
    </Chip.Group>
  );
}

/**
 * The store's Category filter as named chips with their icon. With none picked every category
 * shows (no "All categories" chip). The store query takes ONE category, so picking a chip narrows to
 * it and picking it again goes back to all.
 */
export function CategoryFilterChips({
  value,
  onChange,
}: {
  value: MarketplaceCategory | null;
  onChange: (next: MarketplaceCategory | null) => void;
}) {
  return (
    <Group gap={8} role="group" aria-label="Filter by category">
      {MARKETPLACE_CATEGORIES.map((category) => {
        // A category with no icon yet falls back to a generic one rather than crashing the row.
        const Icon = CATEGORY_ICONS[category] ?? FALLBACK_CATEGORY_ICON;
        const on = value === category;
        return (
          <FilterChip
            key={category}
            checked={on}
            onChange={() => onChange(value === category ? null : category)}
            aria-pressed={on}
          >
            <Group gap={4} wrap="nowrap">
              <Icon size={14} />
              {MARKETPLACE_CATEGORY_LABELS[category]}
            </Group>
          </FilterChip>
        );
      })}
    </Group>
  );
}
