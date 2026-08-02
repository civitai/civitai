import { Button, Divider, Group, Stack } from '@mantine/core';
import { AdaptiveFiltersDropdown } from '~/components/Filters/AdaptiveFiltersDropdown';
import { CategoryFilterButtons } from '~/components/Apps/CategoryFilterButtons';
import { KindFilterButtons } from '~/components/Apps/KindFilterButtons';
import {
  APPS_STORE_DEFAULTS,
  countActiveAppsStoreFilters,
  type AppsStoreFilters,
} from '~/components/Apps/appsStoreQueryParams';

/**
 * `/apps` store FILTERS — the single `[⚙ Filters ②]` control that replaced two
 * full-width rows of toggles.
 *
 * The store used to stack three rows: search + sort, then the kind toggles,
 * then the category icons — ~150px of chrome above the first card, and a shape
 * that matched nothing else on the site. This collapses the two toggle rows
 * into the same Filters dropdown `/models` uses, leaving ONE control row of
 * search + sort + Filters.
 *
 * 🔴 BUILT ON THE SHARED {@link AdaptiveFiltersDropdown}, not a hand-rolled
 * popover. That component is what `/models` reaches through `ModelFiltersDropdown`,
 * and it already solves the four things a hand-rolled one gets wrong: the
 * desktop-popover / mobile-drawer switch (`useIsMobile`), the count `Indicator`
 * (gated on `useIsClient()`, because a badge whose value depends on client state
 * is a hydration mismatch), the `IconFilter` + rotating-chevron affordance, and
 * the pill geometry that lines the button up with the rest of a filter row.
 *
 * WHAT IS AND IS NOT IN THE PANEL. Kind and category are in; search and sort stay
 * INLINE in the control row. Search is the primary action on a store page and
 * burying it behind a click is a straight downgrade; sort is not a filter (it
 * always has a value, so it can never read as "off") and `/models` keeps its own
 * sort inline for the same reason. The `Indicator` count therefore counts ONLY
 * the panel's own two controls — see `countActiveAppsStoreFilters`.
 *
 * The two control groups are the EXISTING components, unmoved: `KindFilterButtons`
 * (extracted verbatim from the body) and `CategoryFilterButtons` (which the legacy
 * `MarketplaceBody` rollback path also imports — its contract is untouched here).
 * Their accessibility work (`role="group"` + `aria-label` on each row,
 * `aria-pressed` on every toggle, `Tooltip` + `aria-label` on the icon-only
 * category buttons) comes along unchanged, so the panel is keyboard- and
 * screen-reader-navigable without any new affordances.
 */
export interface AppsStoreFiltersDropdownProps {
  filters: Pick<AppsStoreFilters, 'kind' | 'category'>;
  onChange: (next: Partial<AppsStoreFilters>) => void;
}

export function AppsStoreFiltersDropdown({ filters, onChange }: AppsStoreFiltersDropdownProps) {
  const count = countActiveAppsStoreFilters(filters);

  return (
    <AdaptiveFiltersDropdown count={count} data-testid="apps-store-filters-dropdown">
      <Stack gap="md" p="md" data-testid="apps-store-filters-panel">
        <Stack gap={8}>
          {/* `Divider label=` is the /models panel's section-header idiom — a
              labelled rule rather than a heading, so the panel doesn't inject
              h3s into the page's heading outline. */}
          <Divider label="Type" className="text-sm font-bold" />
          <KindFilterButtons value={filters.kind} onChange={(kind) => onChange({ kind })} />
        </Stack>

        <Stack gap={8}>
          <Divider label="Category" className="text-sm font-bold" />
          <CategoryFilterButtons
            value={filters.category}
            onChange={(category) => onChange({ category })}
          />
        </Stack>

        {/*
          "Clear all" resets exactly the controls this panel owns — kind and
          category — which is the same set the `Indicator` counts. It deliberately
          does NOT clear the search box: the box is visible in the row outside
          this panel, wiping text a viewer can still see (and did not ask to lose)
          from a control they cannot see is the kind of surprise that makes people
          stop trusting a Clear button. The EMPTY-STATE "Clear filters" button is
          the broader one and does clear search too — it is shown next to "No apps
          match", where the viewer cannot tell which control caused the empty grid
          (see `hasActiveAppsStoreFilters`).

          Disabled at count 0 so the affordance states plainly that there is
          nothing to clear, rather than being a no-op that looks broken.
        */}
        <Group justify="flex-end">
          <Button
            variant="subtle"
            size="compact-sm"
            disabled={count === 0}
            data-testid="apps-store-filters-clear"
            onClick={() =>
              onChange({
                kind: APPS_STORE_DEFAULTS.kind,
                category: APPS_STORE_DEFAULTS.category,
              })
            }
          >
            Clear all
          </Button>
        </Group>
      </Stack>
    </AdaptiveFiltersDropdown>
  );
}
