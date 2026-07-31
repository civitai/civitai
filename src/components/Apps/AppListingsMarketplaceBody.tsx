import { Button, Center, Grid, Group, Loader, Select, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconApps, IconExternalLink, IconLayoutGrid, IconSearch } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { AppListingCard } from '~/components/Apps/AppListingCard';
import { LISTING_GRID_SPAN } from '~/components/Apps/appListingGrid';
import { CategoryFilterButtons } from '~/components/Apps/CategoryFilterButtons';
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
import { type MarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import type {
  ListingCard,
  ListingKindFilter,
  ListingSort,
} from '~/server/schema/blocks/app-listing-read.schema';
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
 */

const SORT_OPTIONS: { value: ListingSort; label: string }[] = [
  { value: 'top-rated', label: 'Top rated' },
  { value: 'popular', label: 'Most popular' },
  { value: 'newest', label: 'Newest' },
  { value: 'name', label: 'Name (A–Z)' },
];

const KIND_OPTIONS: { value: ListingKindFilter; label: string; icon: typeof IconApps }[] = [
  { value: 'all', label: 'All apps', icon: IconLayoutGrid },
  { value: 'onsite', label: 'On-site', icon: IconApps },
  { value: 'offsite', label: 'Off-site', icon: IconExternalLink },
];

/**
 * Kind filter — a small row of single-select toggle buttons (all / on-site /
 * off-site), matching the CategoryFilterButtons toggle idiom (Mantine `variant`
 * filled/subtle for active + `aria-pressed` so the state isn't colour-only).
 */
function KindFilterButtons({
  value,
  onChange,
}: {
  value: ListingKindFilter;
  onChange: (next: ListingKindFilter) => void;
}) {
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

export function AppListingsMarketplaceBody() {
  const features = useFeatureFlags();
  const [kind, setKind] = useState<ListingKindFilter>('all');
  const [category, setCategory] = useState<MarketplaceCategory | null>(null);
  const [sort, setSort] = useState<ListingSort>('top-rated');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch] = useDebouncedValue(searchInput, 300);

  // "Recently opened" rail (client-only personalisation from localStorage).
  // SEEDED EMPTY so SSR and the first client render match — reading
  // localStorage during render would be a hydration mismatch — and the real
  // list loads in a post-mount effect. A viewer with no recents therefore sees
  // the page exactly as before: `RecentlyOpenedListingsView` renders null for an
  // empty list, so nothing (not even a spacer) is added above the search box.
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

  const hasActiveFilters =
    searchInput.trim().length > 0 || category != null || kind !== 'all';

  function clearFilters() {
    setKind('all');
    setCategory(null);
    setSearchInput('');
  }

  const showingEmpty = !isLoading && filteredItems.length === 0;

  return (
    <Stack gap="md">
      {/* RECENTLY OPENED — at the very top, ABOVE the search input: it is a
          "jump back in" shortcut for a returning viewer, so burying it under the
          filters (where the legacy body put it, at the BOTTOM) defeats it.
          Renders null when empty, so a first-time viewer's layout is unchanged
          and nothing shifts when the post-mount localStorage read lands. */}
      <RecentlyOpenedListingsView
        entries={recentEntries}
        canOpenPage={!!features.appBlocksPages}
        onOpenRecent={handleOpenRecent}
      />

      <Group gap="md" align="end">
        <TextInput
          label="Search"
          placeholder="Search by name"
          leftSection={<IconSearch size={16} />}
          value={searchInput}
          onChange={(e) => setSearchInput(e.currentTarget.value)}
          style={{ flex: 1, minWidth: 240 }}
        />
        <Select
          label="Sort"
          data={SORT_OPTIONS}
          value={sort}
          onChange={(v) => setSort((v as ListingSort) ?? 'top-rated')}
          allowDeselect={false}
          w={180}
        />
      </Group>

      {/* Kind filter (all / on-site / off-site). */}
      <KindFilterButtons value={kind} onChange={setKind} />

      {/* Category icon toggles — reuses the live marketplace component + taxonomy. */}
      <CategoryFilterButtons value={category} onChange={setCategory} />

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
