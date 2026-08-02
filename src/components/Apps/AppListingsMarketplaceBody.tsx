import { Button, Center, Grid, Group, Loader, Select, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { AppListingCard } from '~/components/Apps/AppListingCard';
import { LISTING_GRID_SPAN } from '~/components/Apps/appListingGrid';
import { AppsStoreFiltersDropdown } from '~/components/Apps/AppsStoreFiltersDropdown';
import { hasActiveAppsStoreFilters } from '~/components/Apps/appsStoreQueryParams';
import { useAppsStoreQueryParams } from '~/components/Apps/useAppsStoreQueryParams';
import { RecentlyOpenedListingsView } from '~/components/Apps/RecentlyOpenedApps';
import {
  selectRecentRailEntries,
  type ResolvedRecentApp,
} from '~/components/Apps/recentAppsRail';
import {
  getRecentlyOpenedApps,
  recordRecentlyOpenedApp,
  type RecentApp,
} from '~/components/Apps/recentlyOpenedAppsStore';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ListingCard, ListingSort } from '~/server/schema/blocks/app-listing-read.schema';
import { trpc } from '~/utils/trpc';

/**
 * App Store Listings (W13) — P2b unified store BODY (grid over BOTH kinds).
 *
 * Consumes `appListings.listAvailable` (the P2a read path) and renders the
 * kind-aware `AppListingCard` grid with a kind filter (all / on-site / off-site),
 * the category icon toggles, the 4 store sorts, cursor pagination, and
 * empty/loading states. Mirrors the structure of the live `MarketplaceBody` so
 * the two feel identical.
 *
 * LIVE (P2d cut over): this is now the DEFAULT `/apps` store grid (see
 * `src/pages/apps/index.tsx`), replacing the legacy `MarketplaceBody` →
 * `AppBlockCard` path (retained in the tree as a one-line rollback). The page is
 * still flag-gated (the App Blocks Flipt segment + `deIndex`) — no longer
 * "store-preview only".
 *
 * ⚠️ Search gap: the P2a `listAvailable` input has NO `query` field (kind /
 * category / sort / cursor / limit only). Server-side search would need a P2a
 * addition — out of scope here (don't add a proc). The search box below filters
 * client-side over the LOADED pages (name + tagline). With today's small catalog
 * (~1 page) that's complete; once listings exceed one page it becomes lossy
 * (unloaded matches are missed) — flagged as the P2a follow-up.
 *
 * ── CONTROLS (product-feedback pass) ────────────────────────────────────────
 * The controls were THREE stacked rows: search + sort, then the kind toggles,
 * then the category icons. They are now ONE row —
 * `[🔍 Search…] [Sort ▾] [⚙ Filters ②]` — with the two toggle rows collapsed
 * into `AppsStoreFiltersDropdown` (the same `AdaptiveFiltersDropdown` `/models`
 * uses). See that file for what is in the panel and why sort/search are not.
 *
 * ── URL STATE ───────────────────────────────────────────────────────────────
 * Filters/sort/search now live in the query string
 * (`/apps?kind=offsite&category=generation&sort=newest`) via
 * `useAppsStoreQueryParams`, so a filtered store is shareable and survives
 * reload + Back. Writes are `shallow`, so a filter change does not re-run
 * `getServerSideProps`.
 *
 * 🔴 The search box is the one control that is NOT written straight through.
 * It keeps LOCAL state and only reaches the URL via the existing 300ms
 * `useDebouncedValue`, because `router.replace` per keystroke pushes a history
 * entry's worth of work per character and makes the Back button unusable
 * (~1 entry per letter typed). The input therefore renders from local state and
 * the URL is the debounced echo — see `searchInput` below.
 */

const SORT_OPTIONS: { value: ListingSort; label: string }[] = [
  { value: 'top-rated', label: 'Top rated' },
  { value: 'popular', label: 'Most popular' },
  { value: 'newest', label: 'Newest' },
  { value: 'name', label: 'Name (A–Z)' },
];

export function AppListingsMarketplaceBody() {
  const features = useFeatureFlags();
  const { filters, setFilters } = useAppsStoreQueryParams();
  const { kind, category, sort } = filters;

  // 🔴 The search input is LOCAL, seeded ONCE from the URL. It is not a
  // controlled mirror of `filters.query`, for the reason in the header comment:
  // the URL only receives the DEBOUNCED value, so binding the input to the URL
  // would make every keystroke render the stale (pre-debounce) text and fight
  // the caret. Seeding from `filters.query` is what makes a shared/reloaded
  // `?query=` link show its own search term in the box.
  //
  // Hydration-safe: `filters.query` is a pure function of `router.query`, which
  // is identical on the server and the first client paint for this
  // `getServerSideProps` page — no `window`/`localStorage` read here.
  const [searchInput, setSearchInput] = useState(filters.query);
  const [debouncedSearch] = useDebouncedValue(searchInput, 300);

  // Echo the DEBOUNCED search into the URL (never per keystroke). Guarded on
  // inequality so this effect can't loop against the router, and so a filter
  // change that leaves the search alone doesn't rewrite `query`.
  useEffect(() => {
    if (debouncedSearch.trim() === filters.query.trim()) return;
    setFilters({ query: debouncedSearch });
  }, [debouncedSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Recently opened" rail (client-only personalisation from localStorage).
  // SEEDED EMPTY so SSR and the first client render match — reading
  // localStorage during render would be a hydration mismatch — and the real
  // list loads in a post-mount effect. A viewer with no recents therefore sees
  // the page exactly as before: `RecentlyOpenedListingsView` renders null for an
  // empty list, so nothing (not even a spacer) is added. The rail is rendered
  // BELOW the search/sort/filter controls precisely because of this one-frame
  // late hydration — see the comment at its render site.
  const [recents, setRecents] = useState<RecentApp[]>([]);
  useEffect(() => {
    setRecents(getRecentlyOpenedApps());
  }, []);
  const recentEntries = useMemo(() => selectRecentRailEntries(recents), [recents]);

  // Re-opening from the rail moves that app back to the front of the store. For
  // an OFF-SITE entry this is the only chance to record it (following the link
  // leaves the SPA); for an on-site one the run page records it too, and the
  // store dedups, so double-recording is harmless.
  function handleOpenRecent(entry: ResolvedRecentApp) {
    setRecents(
      recordRecentlyOpenedApp({
        id: entry.id,
        slug: entry.slug,
        kind: entry.kind,
        hasPage: entry.hasPage,
        ...(entry.blockId ? { blockId: entry.blockId } : {}),
        ...(entry.externalUrl ? { externalUrl: entry.externalUrl } : {}),
        ...(entry.name ? { name: entry.name } : {}),
        ...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {}),
      })
    );
  }

  const {
    data,
    isLoading,
    isError,
    refetch,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
  } = trpc.appListings.listAvailable.useInfiniteQuery(
    {
      kind,
      category: category ?? undefined,
      sort,
      limit: 24,
    },
    {
      // W13 (PR-W1a/D8): store-visibility gate = dedicated `appListings`
      // OR-falling-back to `appBlocks`. Mirrors the server read gate
      // (`enforceAppListingsReadFlag` → `isAppListingsEnabled`). Zero behavior
      // change today (the `app-listings` flag doesn't exist yet).
      enabled: !!(features.appListings || features.appBlocks),
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  const items = useMemo(
    () => (data?.pages ?? []).flatMap((p) => p.items as ListingCard[]),
    [data]
  );

  // Client-side search over loaded pages (name + tagline). See the ⚠️ gap note:
  // this is complete only while the catalog fits in the loaded pages.
  const filteredItems = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.tagline ? c.tagline.toLowerCase().includes(q) : false)
    );
  }, [items, debouncedSearch]);

  // The BROAD predicate — includes search, because a viewer looking at an empty
  // grid can't tell which control emptied it. The dropdown's `Indicator` counts
  // the NARROWER set (kind + category only); the two are separate named
  // functions in `appsStoreQueryParams.ts` so the difference stays a decision.
  // Reads `searchInput`, not `filters.query`, so the empty state's "Clear
  // filters" button appears on the same frame the results empty out rather than
  // 300ms later.
  const hasActiveFilters = hasActiveAppsStoreFilters({ kind, category, query: searchInput });

  /** The empty state's reset: clears the panel's filters AND the search box. */
  function clearFilters() {
    setSearchInput('');
    setFilters({ kind: 'all', category: null, query: '' });
  }

  const showingEmpty = !isLoading && filteredItems.length === 0;

  return (
    <Stack gap="md">
      {/*
        ONE control row: search (flexes) · sort · Filters. Replaces the previous
        three stacked rows.

        ALIGNMENT. The row was previously `align="end"` because the search input
        carried a visible `label="Search"` and the sort `Select` carried
        `label="Sort"` — the labels made the two controls different heights, so
        they could only be lined up by their BOTTOM edge, and the filter toggles
        underneath had no label at all and sat on a third baseline. The labels
        are gone (the placeholder + the leading magnifier already say "search",
        and the sort control shows its own value), so all three controls are the
        same height and the row centres cleanly.

        🔴 Removing the visible label does NOT remove the accessible name —
        `aria-label` carries it, so `getByLabelText('Search')` and a screen
        reader still resolve the same names they did before. An icon and a
        placeholder are not an accessible name.

        The `radius="xl"` pills + `size="sm"` (36px) match the `/models` filter
        row geometry, which is what "align the search and sort components" is
        measured against. `wrap="wrap"` so a narrow viewport drops Filters onto
        its own line instead of crushing the search box; `flex: 1` + a 220px
        floor keeps search the dominant control at every width.
      */}
      <Group gap="sm" align="center" wrap="wrap" data-testid="apps-store-control-row">
        <TextInput
          aria-label="Search"
          placeholder="Search by name"
          leftSection={<IconSearch size={16} />}
          value={searchInput}
          onChange={(e) => setSearchInput(e.currentTarget.value)}
          radius="xl"
          size="sm"
          style={{ flex: 1, minWidth: 220 }}
        />
        <Select
          aria-label="Sort"
          data={SORT_OPTIONS}
          value={sort}
          onChange={(v) => setFilters({ sort: (v as ListingSort) ?? 'top-rated' })}
          allowDeselect={false}
          radius="xl"
          size="sm"
          w={180}
        />
        <AppsStoreFiltersDropdown filters={{ kind, category }} onChange={setFilters} />
      </Group>

      {/* RECENTLY OPENED — BELOW the search/sort/filter controls and ABOVE the
          grid.
          🔴 Deliberately not at the very top. The rail is seeded EMPTY for SSR +
          the first client render (reading localStorage during render is a
          hydration mismatch) and hydrates in a post-mount effect, so for a
          viewer WITH recents it appears one frame late. Above the search input
          that insertion pushes the whole page down by ~90px after paint — a pure
          CLS hit on the primary controls, and one we would actually see, since
          Faro RUM reports web-vitals for this page. Below the controls, the late
          insertion only moves the grid, which the viewer has not yet aimed at.
          The rail is still above the fold and above every result card, so the
          "jump back in" shortcut keeps its priority over browsing.
          Renders null when empty → a first-time viewer's layout is byte-identical
          to before, and nothing shifts at all. */}
      <RecentlyOpenedListingsView
        entries={recentEntries}
        canOpenPage={!!features.appBlocksPages}
        onOpenRecent={handleOpenRecent}
      />

      {isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : isError ? (
        <Center py="xl">
          <Stack align="center" gap={8}>
            <Text size="lg" fw={500}>
              Couldn&apos;t load apps
            </Text>
            <Text size="sm" c="dimmed" ta="center" maw={420}>
              Something went wrong loading the app store. Please try again.
            </Text>
            <Button variant="light" size="xs" onClick={() => refetch()}>
              Retry
            </Button>
          </Stack>
        </Center>
      ) : showingEmpty ? (
        <Center py="xl">
          <Stack align="center" gap={8}>
            <Text size="lg" fw={500}>
              {hasActiveFilters ? 'No apps match' : 'No apps yet'}
            </Text>
            <Text size="sm" c="dimmed" ta="center" maw={420}>
              {hasActiveFilters
                ? 'Try clearing your filters or search query.'
                : 'Approved app listings will appear here.'}
            </Text>
            {hasActiveFilters && (
              <Button variant="light" size="xs" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </Stack>
        </Center>
      ) : (
        <>
          {/* Feedback #1 ("make app cover images larger — fewer columns per row?"):
              at `xl` the grid drops 5 columns → 4 (`span` 2.4 → 3), so each card —
              and therefore its responsive 16:9 cover — gets ~25% more width. The
              container width is UNCHANGED (`LISTING_STORE_CONTAINER_SIZE`, still
              1600, on the store index) and every other breakpoint is unchanged
              (base 12 / sm 6 / md 4 / lg 3). Both constants live in
              `appListingGrid.ts` so they're unit-pinned together. */}
          <Grid gutter="md">
            {filteredItems.map((card) => (
              <Grid.Col key={card.id} span={LISTING_GRID_SPAN} data-testid="apps-listing-grid-col">
                <AppListingCard card={card} canOpenPage={!!features.appBlocksPages} />
              </Grid.Col>
            ))}
          </Grid>
          {/* Load-more is hidden while a client-side search is active (it would
              page in more UN-searched items — the searched view is over loaded
              pages only; see the ⚠️ gap note). */}
          {hasNextPage && !debouncedSearch.trim() && (
            <Center py="md">
              <Button
                variant="default"
                loading={isFetchingNextPage}
                onClick={() => fetchNextPage()}
              >
                Load more
              </Button>
            </Center>
          )}
        </>
      )}
    </Stack>
  );
}
