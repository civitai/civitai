import { Divider, Stack } from '@mantine/core';
import { AdaptiveFiltersDropdown } from '~/components/Filters/AdaptiveFiltersDropdown';
import { StagedFiltersFooter } from '~/components/Filters/StagedFiltersFooter';
import { useStagedFilters } from '~/components/Filters/useStagedFilters';
import { CategoryFilterChips, KindFilterChips } from '~/components/Apps/AppsStoreFilterChips';
import { LISTING_FACET_LABELS } from '~/components/Apps/listingKindLabels';
import {
  APPS_STORE_DEFAULTS,
  countActiveAppsStoreFilters,
  type AppsStoreFilters,
} from '~/components/Apps/appsStoreQueryParams';

/**
 * `/apps` store FILTERS: the single `[Filters ②]` control, built on the shared
 * {@link AdaptiveFiltersDropdown} (desktop popover / mobile drawer, count `Indicator`).
 *
 * The panel is the same shape as the other feeds' filter panels: chips, then an Apply / Reset
 * footer and a Clear all filters button, with edits staged until Apply ({@link useStagedFilters}).
 * Kind and category are in; search and sort stay inline in the control row. The `Indicator` count
 * counts only the panel's own two controls — see `countActiveAppsStoreFilters`.
 *
 * There is no "All apps" or "All categories" chip: both kinds, and every category, are on until the
 * viewer narrows. The stored value is unchanged (`kind: 'all'`, `category: null`), so URLs, the
 * query and the count behave as before.
 *
 * "Clear all filters" resets exactly the controls this panel owns, and does not touch the search
 * box: that box is visible outside the panel, and wiping text a viewer can still see from a control
 * they cannot would make people stop trusting the button. The empty-state "Clear filters" button is
 * the broader one (see `hasActiveAppsStoreFilters`).
 */
export interface AppsStoreFiltersDropdownProps {
  filters: Pick<AppsStoreFilters, 'kind' | 'category'>;
  onChange: (next: Partial<AppsStoreFilters>) => void;
}

export function AppsStoreFiltersDropdown({ filters, onChange }: AppsStoreFiltersDropdownProps) {
  const {
    opened,
    toggle,
    close,
    mergedFilters,
    isDirty,
    patchPending,
    apply,
    reset,
    clearAndClose,
  } = useStagedFilters({
    committed: filters,
    onApply: (next) => onChange({ kind: next.kind, category: next.category }),
    onClear: () =>
      onChange({ kind: APPS_STORE_DEFAULTS.kind, category: APPS_STORE_DEFAULTS.category }),
  });
  // The badge previews what Apply would commit while the panel is open.
  const count = countActiveAppsStoreFilters(mergedFilters);

  return (
    <AdaptiveFiltersDropdown
      count={count}
      opened={opened}
      onOpenedChange={(next) => (next ? toggle() : close())}
      data-testid="apps-store-filters-dropdown"
    >
      <Stack gap={0} data-testid="apps-store-filters-panel">
        <Stack gap="lg" p="md">
          <Stack gap={8}>
            {/* `Divider label=` is the /models panel's section-header idiom: a labelled rule, not a
                heading, so the panel doesn't inject h3s into the page's heading outline. */}
            <Divider label={LISTING_FACET_LABELS.kind} className="text-sm font-bold" />
            <KindFilterChips
              value={mergedFilters.kind}
              onChange={(kind) => patchPending({ kind })}
            />
          </Stack>
          <Stack gap={8}>
            <Divider label="Category" className="text-sm font-bold" />
            <CategoryFilterChips
              value={mergedFilters.category}
              onChange={(category) => patchPending({ category })}
            />
          </Stack>
        </Stack>
        <StagedFiltersFooter
          isDirty={isDirty}
          onApply={apply}
          onReset={reset}
          filterLength={count}
          onClear={clearAndClose}
        />
      </Stack>
    </AdaptiveFiltersDropdown>
  );
}
