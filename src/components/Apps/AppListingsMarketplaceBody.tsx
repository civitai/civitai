import { Button, Center, Grid, Group, Loader, Select, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconApps, IconExternalLink, IconLayoutGrid, IconSearch } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { AppListingCard } from '~/components/Apps/AppListingCard';
import { CategoryFilterButtons } from '~/components/Apps/CategoryFilterButtons';
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
 * DARK / parallel-run: mounted only by the mod-only `/apps/store-preview`
 * surface. The default `/apps` render (MarketplaceBody → AppBlockCard) is
 * untouched; the cutover is a later PR (P2d).
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
          <Grid gutter="md">
            {filteredItems.map((card) => (
              <Grid.Col key={card.id} span={{ base: 12, sm: 6, md: 4, lg: 3 }}>
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
