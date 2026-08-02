import { Button, Group } from '@mantine/core';
import { IconApps, IconExternalLink, IconLayoutGrid } from '@tabler/icons-react';
import type { ListingKindFilter } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * Store TYPE filter — a small row of single-select toggle buttons (all /
 * on-site / off-site), matching the {@link CategoryFilterButtons} toggle idiom
 * (Mantine `variant` filled/subtle for active + `aria-pressed` so the state
 * isn't colour-only).
 *
 * EXTRACTED from `AppListingsMarketplaceBody`, where it was a local component,
 * when the store's filters moved into the `/models`-style Filters dropdown: the
 * dropdown panel and the body are now different files, so the control has to be
 * importable. The rendered markup and the props are UNCHANGED by the move — the
 * existing marketplace-body tests that click `Off-site` still address the same
 * button, they just open the dropdown first.
 */
const KIND_OPTIONS: { value: ListingKindFilter; label: string; icon: typeof IconApps }[] = [
  { value: 'all', label: 'All apps', icon: IconLayoutGrid },
  { value: 'onsite', label: 'On-site', icon: IconApps },
  { value: 'offsite', label: 'Off-site', icon: IconExternalLink },
];

export interface KindFilterButtonsProps {
  value: ListingKindFilter;
  onChange: (next: ListingKindFilter) => void;
}

export function KindFilterButtons({ value, onChange }: KindFilterButtonsProps) {
  return (
    <Group gap="xs" role="group" aria-label="Filter by app kind">
      {KIND_OPTIONS.map(({ value: v, label, icon: Icon }) => {
        const active = value === v;
        return (
          <Button
            key={v}
            size="xs"
            variant={active ? 'filled' : 'subtle'}
            color="blue"
            aria-pressed={active}
            leftSection={<Icon size={14} />}
            onClick={() => onChange(v)}
          >
            {label}
          </Button>
        );
      })}
    </Group>
  );
}
