import { Button, Center, Grid, Group, Loader, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconLayoutGrid, IconPlus, IconSearch } from '@tabler/icons-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { AppBlockCard } from '~/components/Apps/AppBlockCard';
import { CategoryFilterButtons } from '~/components/Apps/CategoryFilterButtons';
import { RecentlyOpenedAppsView } from '~/components/Apps/RecentlyOpenedApps';
import {
  getRecentlyOpenedApps,
  recordRecentlyOpenedApp,
  type RecentApp,
} from '~/components/Apps/recentlyOpenedApps';
import { openAppSettingsModal } from '~/components/Apps/AppSettingsModal';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';
import { type MarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import type {
  AvailableBlock,
  MarketplaceSort,
  SubscriptionRecord,
  SubscriptionScope,
} from '~/server/schema/blocks/subscription.schema';
import { trpc } from '~/utils/trpc';
import { type ModelSlotId } from '~/shared/constants/slot-registry';

/**
 * App Blocks marketplace BODY — the content rendered INSIDE `AppsPageLayout`
 * (the page chrome) on `/apps`. Extracted out of the page file so it can be
 * component-tested without dragging in the page's `getServerSideProps` →
 * server-env import (which throws outside a configured server).
 *
 * Layout (top → bottom):
 *   [search] [sort]                 — one top control row
 *   [category icon toggle buttons]  — replaces the old category <Select>
 *   [featured / new rails]          — unfiltered default view only
 *   [app results grid]              — search + sort + category filtered
 *   [recently opened]               — localStorage-sourced, hidden when empty
 *   [explore all apps]              — bottom CTA, clears the active filters
 *
 * The listing query is UNCHANGED — only the controls around it changed.
 */

// Marketplace slot filter — model-entity region slots ONLY. The slot-filter UI
// is hidden for the page-apps-only launch, but the state is retained (defaults
// to null = "All slots") so the listing query stays unaffected; the filter UI
// can be re-shown without re-plumbing.
type SlotFilter = ModelSlotId;

const SORT_OPTIONS: { value: MarketplaceSort; label: string }[] = [
  { value: 'rating', label: 'Top rated' },
  { value: 'popular', label: 'Most popular' },
  { value: 'newest', label: 'Newest' },
  { value: 'name', label: 'Name (A–Z)' },
];

export function MarketplaceBody() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const [slotFilter, setSlotFilter] = useState<SlotFilter | null>(null);
  const [category, setCategory] = useState<MarketplaceCategory | null>(null);
  const [sort, setSort] = useState<MarketplaceSort>('rating');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch] = useDebouncedValue(searchInput, 300);

  // Recently-opened apps (client-only personalisation, sourced from
  // localStorage). Seeded empty so SSR + first client render match (no
  // hydration mismatch); the real list is loaded in an effect after mount, and
  // updated whenever the viewer opens an app via handleOpen.
  const [recents, setRecents] = useState<RecentApp[]>([]);
  useEffect(() => {
    setRecents(getRecentlyOpenedApps());
  }, []);

  // The marketplace listing is anon-CAPABLE (publicProcedure) — it fires for
  // any viewer who has the appBlocks flag, including a session-less one once
  // the segment widens (dark today). It returns only approved apps + a public
  // field allowlist.
  //
  // F-E E3: cursor-paginated via useInfiniteQuery (the `cursor` was always in
  // the schema but the page used to request a flat limit:50 and never paginate
  // → silent >50 truncation). Now we page through ALL approved apps.
  const {
    data: availableData,
    isLoading,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
  } = trpc.blocks.listAvailable.useInfiniteQuery(
    {
      slotId: slotFilter ?? undefined,
      category: category ?? undefined,
      sort,
      query: debouncedSearch || undefined,
      limit: 24,
    },
    {
      enabled: !!features.appBlocks,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  const items = useMemo(
    () => (availableData?.pages ?? []).flatMap((p) => p.items as AvailableBlock[]),
    [availableData]
  );

  const hasActiveFilters = Boolean(
    slotFilter || category || (debouncedSearch && debouncedSearch.length > 0)
  );

  // F-E E4 discovery rails — shown ABOVE the grid only on the unfiltered default
  // view (a "Featured" staff-pick rail + a "New" recently-deployed rail). When
  // the viewer is actively searching/filtering they want the full grid, so the
  // rails collapse to avoid duplicating cards. Both reuse the SAME anon-capable,
  // approved-only public projection as the grid (no extra exposure).
  const showRails = !hasActiveFilters;

  const { data: featuredData } = trpc.blocks.getFeaturedBlocks.useQuery(
    { limit: 12 },
    { enabled: !!features.appBlocks && showRails }
  );
  const featuredItems = (featuredData?.items ?? []) as AvailableBlock[];

  // "New" rail: newest-deployed apps, small fixed page (the first page of the
  // newest sort). Reuses listAvailable, so it's the same projection + gate.
  const { data: newData } = trpc.blocks.listAvailable.useQuery(
    { sort: 'newest', limit: 8 },
    { enabled: !!features.appBlocks && showRails }
  );
  const newItems = (newData?.items ?? []) as AvailableBlock[];

  // E4 Low-1: when the rails are shown, exclude the apps they already surface
  // from the "All apps" grid so a featured/new app doesn't render twice.
  const railIds = useMemo(
    () => new Set(showRails ? [...featuredItems, ...newItems].map((b) => b.id) : []),
    [showRails, featuredItems, newItems]
  );
  const gridItems = useMemo(() => items.filter((b) => !railIds.has(b.id)), [items, railIds]);

  // M1 empty-state: distinguish "no apps exist at all" (total===0) from
  // "your filters matched nothing" (filtered===0). A tiny unfiltered probe
  // (limit:1, no filters/search) tells us whether ANY approved app exists,
  // without a server change. Only fires when the current filtered view is
  // empty AND filters are active (so the common no-filter empty case doesn't
  // double-query).
  const { data: probeData, isLoading: probeLoading } = trpc.blocks.listAvailable.useQuery(
    { limit: 1, sort: 'popular' },
    { enabled: !!features.appBlocks && items.length === 0 && hasActiveFilters }
  );
  const anyAppsExist = items.length > 0 || (probeData?.items?.length ?? 0) > 0;

  // The per-user queries below are protectedProcedure — they 401 for an anon
  // viewer. Guard on a logged-in user so the dark anon read path doesn't fire
  // them. (`features.appBlocks` alone isn't enough: behind a widened segment an
  // anon viewer would still hit these.)
  const { data: mySubs } = trpc.blocks.listMySubscriptions.useQuery(undefined, {
    enabled: !!features.appBlocks && !!currentUser,
  });
  // Lifetime earnings per owned app — feeds the "Earning $X" chip on
  // marketplace cards owned by the viewer. Visible only to the owner;
  // the trPC procedure is guarded so other users get nothing back.
  const { data: myAppsRaw } = trpc.blocks.getMyApps.useQuery(undefined, {
    // getMyApps is a moderatorProcedure — gate on the same developer predicate as
    // the rest of the funnel so a non-developer never fires it (today: mod-only;
    // post-W11-widen: only app developers, not every logged-in marketplace viewer).
    enabled: !!features.appBlocks && isAppDeveloper(currentUser),
  });
  const earningsByAppBlockId = useMemo(() => {
    type AppRow = { id: string; lifetimeShareCents: number };
    const map = new Map<string, number>();
    for (const a of (myAppsRaw ?? []) as AppRow[]) {
      map.set(a.id, a.lifetimeShareCents ?? 0);
    }
    return map;
  }, [myAppsRaw]);

  // Index existing subscriptions by appBlockId so we know whether to show
  // Install vs Manage on each card.
  const subsByBlock = useMemo(() => {
    const map = new Map<string, Partial<Record<SubscriptionScope, SubscriptionRecord>>>();
    for (const sub of mySubs ?? []) {
      const existing = map.get(sub.appBlockId) ?? {};
      existing[sub.scope] = sub;
      map.set(sub.appBlockId, existing);
    }
    return map;
  }, [mySubs]);

  // Resolve the localStorage recents (ids only) against the apps we've already
  // fetched (grid items + the featured/new rails) so the "Recently opened" strip
  // reuses the SAME public AvailableBlock projection as every other card — no
  // extra query, no extra exposure. A recent id we haven't fetched (e.g. it
  // dropped off the listing) is simply skipped. Order is preserved newest-first
  // (the recents list order), and we de-dup by id.
  const blocksById = useMemo(() => {
    const map = new Map<string, AvailableBlock>();
    for (const b of [...items, ...featuredItems, ...newItems]) {
      if (!map.has(b.id)) map.set(b.id, b);
    }
    return map;
  }, [items, featuredItems, newItems]);

  const recentBlocks = useMemo(() => {
    const out: AvailableBlock[] = [];
    const seen = new Set<string>();
    for (const r of recents) {
      const block = blocksById.get(r.id);
      if (block && !seen.has(block.id)) {
        seen.add(block.id);
        out.push(block);
      }
    }
    return out;
  }, [recents, blocksById]);

  function handleOpen(block: AvailableBlock) {
    // Record the open in the client-only recents list BEFORE opening the
    // settings panel (capped + deduped + newest-first inside the helper).
    setRecents(recordRecentlyOpenedApp({ id: block.id, blockId: block.blockId }));
    openAppSettingsModal({
      block,
      existingByScope: subsByBlock.get(block.id) ?? {},
    });
  }

  function clearFilters() {
    setSlotFilter(null);
    setCategory(null);
    setSearchInput('');
  }

  const showingEmpty = !isLoading && items.length === 0;

  return (
    <Stack gap="md">
      {/* TOP ROW — search + sort together. The category control was moved
          OUT of this row into the icon-toggle button row below. */}
      <Group gap="md" align="end">
        <TextInput
          label="Search"
          placeholder="Search by name or block id"
          leftSection={<IconSearch size={16} />}
          value={searchInput}
          onChange={(e) => setSearchInput(e.currentTarget.value)}
          style={{ flex: 1, minWidth: 240 }}
        />
        <Select
          label="Sort"
          data={SORT_OPTIONS}
          value={sort}
          onChange={(v) => setSort((v as MarketplaceSort) ?? 'popular')}
          allowDeselect={false}
          w={170}
        />
      </Group>

      {/* CATEGORY ICON TOGGLES — replaces the old category <Select>. Drives
          the SAME `category` filter state (so the listing query is
          unchanged); single-select with an "All" clear. */}
      <CategoryFilterButtons value={category} onChange={setCategory} />

      {/* Slot/location filter intentionally hidden for the page-apps-only
          launch — the slot filter UI only makes sense once model-slot apps
          are public. The slotFilter state is retained (defaults to null =
          "All slots") so the listing query is unaffected. */}

      {/* F-E E4 discovery rails — unfiltered default view only. Featured =
          curated staff picks (sorted by mod-assigned featured_order); New =
          recently deployed. Each card links to the detail page + installs
          via the same handler as the grid. */}
      {showRails && featuredItems.length > 0 && (
        <MarketplaceRail
          title="Featured"
          blocks={featuredItems}
          subsByBlock={subsByBlock}
          onOpen={handleOpen}
          earningsByAppBlockId={earningsByAppBlockId}
          canOpenPage={!!features.appBlocksPages}
        />
      )}
      {showRails && newItems.length > 0 && (
        <MarketplaceRail
          title="New"
          blocks={newItems}
          subsByBlock={subsByBlock}
          onOpen={handleOpen}
          earningsByAppBlockId={earningsByAppBlockId}
          canOpenPage={!!features.appBlocksPages}
        />
      )}

      {showRails &&
        (featuredItems.length > 0 || newItems.length > 0) &&
        gridItems.length > 0 && (
          <Title order={3} mt="xs">
            All apps
          </Title>
        )}

      {isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : showingEmpty ? (
        <MarketplaceEmptyState
          anyAppsExist={anyAppsExist}
          probeLoading={probeLoading && hasActiveFilters}
          hasActiveFilters={hasActiveFilters}
          onClearFilters={clearFilters}
          canSubmit={isAppDeveloper(currentUser)}
        />
      ) : (
        <>
          <Grid gutter="md">
            {gridItems.map((block: AvailableBlock) => (
              <Grid.Col key={block.id} span={{ base: 12, sm: 6, md: 4, lg: 3 }}>
                <AppBlockCard
                  block={block}
                  alreadySubscribed={subsByBlock.has(block.id)}
                  onOpen={handleOpen}
                  ownedEarningCents={earningsByAppBlockId.get(block.id)}
                  canOpenPage={!!features.appBlocksPages}
                />
              </Grid.Col>
            ))}
          </Grid>
          {hasNextPage && (
            <Center py="md">
              <Button variant="default" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
                Load more
              </Button>
            </Center>
          )}
        </>
      )}

      {/* RECENTLY OPENED — client-only personalisation from localStorage,
          resolved against the apps we've already fetched. Hidden entirely
          when the viewer has no recents (new viewer). */}
      <RecentlyOpenedAppsView
        blocks={recentBlocks}
        subsByBlock={subsByBlock}
        onOpen={handleOpen}
        earningsByAppBlockId={earningsByAppBlockId}
        canOpenPage={!!features.appBlocksPages}
      />

      {/* EXPLORE ALL APPS — bottom CTA. Clears the active category + search
          filters to drop the viewer into the full catalog. Hidden when no
          filters are active (it's already the full catalog). */}
      {hasActiveFilters && (
        <Center py="md">
          <Button
            variant="light"
            size="md"
            leftSection={<IconLayoutGrid size={18} />}
            onClick={clearFilters}
          >
            Explore all apps
          </Button>
        </Center>
      )}
    </Stack>
  );
}

/**
 * M1 empty-state. Distinguishes two cases:
 *   - NO apps exist at all (anyAppsExist === false) → a friendly intro + a
 *     Submit CTA for eligible (mod) viewers.
 *   - filters matched nothing (apps exist but the current filter set is empty)
 *     → the "clear filters" copy.
 * While the probe is still resolving (filters active, view empty) we render a
 * neutral loader to avoid flashing the wrong message.
 */
function MarketplaceEmptyState({
  anyAppsExist,
  probeLoading,
  hasActiveFilters,
  onClearFilters,
  canSubmit,
}: {
  anyAppsExist: boolean;
  probeLoading: boolean;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  canSubmit: boolean;
}) {
  if (probeLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  // Apps exist but the current filters matched nothing.
  if (anyAppsExist && hasActiveFilters) {
    return (
      <Center py="xl">
        <Stack align="center" gap={8}>
          <Text size="lg" fw={500}>
            No app blocks match
          </Text>
          <Text size="sm" c="dimmed">
            Try clearing your filters or search query.
          </Text>
          <Button variant="light" size="xs" onClick={onClearFilters}>
            Clear filters
          </Button>
        </Stack>
      </Center>
    );
  }

  // No apps exist at all (or, defensively, an empty view with no active
  // filters) → friendly intro + Submit CTA for eligible viewers.
  return (
    <Center py="xl">
      <Stack align="center" gap={8}>
        <Text size="lg" fw={500}>
          No apps yet
        </Text>
        <Text size="sm" c="dimmed" ta="center" maw={420}>
          App Blocks add interactive panels to model pages — generation, games, utilities and
          more. Be the first to publish one.
        </Text>
        {canSubmit && (
          <Button
            component={Link}
            href="/apps/submit"
            leftSection={<IconPlus size={16} />}
            variant="light"
            size="xs"
          >
            Submit an app
          </Button>
        )}
      </Stack>
    </Center>
  );
}

/**
 * F-E E4 discovery rail — a titled horizontal strip of marketplace cards
 * (Featured / New) shown above the grid on the unfiltered view. Reuses
 * AppBlockCard so each card behaves identically to the grid (detail link +
 * install handler + owner-earnings chip).
 */
function MarketplaceRail({
  title,
  blocks,
  subsByBlock,
  onOpen,
  earningsByAppBlockId,
  canOpenPage,
}: {
  title: string;
  blocks: AvailableBlock[];
  subsByBlock: Map<string, Partial<Record<SubscriptionScope, SubscriptionRecord>>>;
  onOpen: (block: AvailableBlock) => void;
  earningsByAppBlockId: Map<string, number>;
  canOpenPage: boolean;
}) {
  return (
    <Stack gap="xs">
      <Title order={3}>{title}</Title>
      <Grid gutter="md">
        {blocks.map((block) => (
          <Grid.Col key={block.id} span={{ base: 12, sm: 6, md: 4, lg: 3 }}>
            <AppBlockCard
              block={block}
              alreadySubscribed={subsByBlock.has(block.id)}
              onOpen={onOpen}
              ownedEarningCents={earningsByAppBlockId.get(block.id)}
              canOpenPage={canOpenPage}
            />
          </Grid.Col>
        ))}
      </Grid>
    </Stack>
  );
}
