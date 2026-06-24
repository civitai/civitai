import { ActionIcon, Group, Tooltip } from '@mantine/core';
import { IconLayoutGrid } from '@tabler/icons-react';
import {
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_LABELS,
  type MarketplaceCategory,
} from '~/server/services/blocks/marketplace-categories.constants';
import { CATEGORY_ICONS } from '~/components/Apps/marketplaceCategoryIcons';

/**
 * Marketplace category filter — a row of single-select icon TOGGLE buttons, one
 * per `MARKETPLACE_CATEGORIES`, plus a leading "All" toggle that clears the
 * filter. Replaces the old category `<Select>` dropdown; it drives the SAME
 * `category` filter state the dropdown drove (so the listing query is
 * unchanged — only the control changed).
 *
 * Behaviour:
 *  - Single-select: clicking a category sets it as the active filter; clicking
 *    the ALREADY-active category clears it back to "All" (null).
 *  - "All" is active (visible filled state) exactly when no category is
 *    selected; clicking it clears the filter.
 *  - Each button is icon-only for compactness but is labelled with the category
 *    name via a `Tooltip` AND an `aria-label`, so it's accessible to screen
 *    readers and keyboard users (the icon alone is not an accessible name).
 *
 * Active state is conveyed with Mantine `variant` (`filled` active /
 * `subtle` inactive) AND `aria-pressed` (so the toggle state is exposed
 * programmatically, not by colour alone).
 */
export interface CategoryFilterButtonsProps {
  /** The currently-selected category, or `null` for "All". */
  value: MarketplaceCategory | null;
  /** Called with the next selection (a category, or `null` to clear to "All"). */
  onChange: (next: MarketplaceCategory | null) => void;
}

export function CategoryFilterButtons({ value, onChange }: CategoryFilterButtonsProps) {
  return (
    <Group gap="xs" role="group" aria-label="Filter by category">
      <Tooltip label="All categories" withArrow>
        <ActionIcon
          variant={value === null ? 'filled' : 'subtle'}
          color="blue"
          size="lg"
          aria-label="All categories"
          aria-pressed={value === null}
          onClick={() => onChange(null)}
        >
          <IconLayoutGrid size={18} />
        </ActionIcon>
      </Tooltip>

      {MARKETPLACE_CATEGORIES.map((category) => {
        const Icon = CATEGORY_ICONS[category];
        const label = MARKETPLACE_CATEGORY_LABELS[category];
        const active = value === category;
        return (
          <Tooltip key={category} label={label} withArrow>
            <ActionIcon
              variant={active ? 'filled' : 'subtle'}
              color="blue"
              size="lg"
              aria-label={label}
              aria-pressed={active}
              // Single-select toggle: re-clicking the active category clears it.
              onClick={() => onChange(active ? null : category)}
            >
              <Icon size={18} />
            </ActionIcon>
          </Tooltip>
        );
      })}
    </Group>
  );
}
