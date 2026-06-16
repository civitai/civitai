import {
  Button,
  Center,
  Chip,
  Container,
  Grid,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconPlugConnected, IconPlus, IconSearch } from '@tabler/icons-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppBlockCard } from '~/components/Apps/AppBlockCard';
import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { openAppSettingsModal } from '~/components/Apps/AppSettingsModal';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';
import {
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_LABELS,
  type MarketplaceCategory,
} from '~/server/services/blocks/marketplace-categories.constants';
import type {
  AvailableBlock,
  MarketplaceSort,
  SubscriptionRecord,
  SubscriptionScope,
} from '~/server/schema/blocks/subscription.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

type SlotFilter = 'model.sidebar_top' | 'model.below_images' | 'model.actions_extra';

const SORT_OPTIONS: { value: MarketplaceSort; label: string }[] = [
  { value: 'popular', label: 'Most popular' },
  { value: 'newest', label: 'Newest' },
  { value: 'name', label: 'Name (A–Z)' },
];

const CATEGORY_OPTIONS = MARKETPLACE_CATEGORIES.map((c) => ({
  value: c,
  label: MARKETPLACE_CATEGORY_LABELS[c],
}));

export const getServerSideProps = createServerSideProps({
  useSession: true,
  // GATING INVARIANT (F-E E1): the flag gate is the ONLY access control; no
  // session→login redirect, so the marketplace renders for a session-less
  // request BEHIND the flag (dark today; lit when the segment widens). See
  // resolveAppsPageAccess for the full invariant + `deIndex` note.
  resolver: async ({ features }) => resolveAppsPageAccess({ features }),
});

export default function AppsPage() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const [slotFilter, setSlotFilter] = useState<SlotFilter | null>(null);
  const [category, setCategory] = useState<MarketplaceCategory | null>(null);
  const [sort, setSort] = useState<MarketplaceSort>('popular');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch] = useDebouncedValue(searchInput, 300);

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
  const anyAppsExist =
    items.length > 0 || (probeData?.items?.length ?? 0) > 0;

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

  function handleOpen(block: AvailableBlock) {
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

  if (!features.appBlocks) return <NotFound />;

  const showingEmpty = !isLoading && items.length === 0;

  return (
    <>
      <Meta title="Apps — Civitai" description="Civitai App Blocks marketplace" deIndex />
      <Container size="xl" py="md">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <Stack gap={4}>
              <Title order={2}>Civitai App Blocks</Title>
              <Text c="dimmed" size="sm">
                Add interactive blocks to your models, or subscribe to ones you want to see
                everywhere.
              </Text>
            </Stack>
            <Group gap="xs">
              {/* Bridge back to /apps/installed so users who subscribe from
                  the marketplace can find where to manage what they have.
                  Always rendered — /apps/installed handles the anon →
                  /login redirect itself. */}
              <Button
                component={Link}
                href="/apps/installed"
                leftSection={<IconPlugConnected size={16} />}
                variant="default"
              >
                My installed apps
              </Button>
              {/* Submit-new link — only rendered for the civitai-team (mod-gated
                  tRPC mutation would already reject anyone else). v1 replaces
                  the gate with the W1 review queue. */}
              <SubmitAppLink />
            </Group>
          </Group>

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
            <Select
              label="Category"
              data={CATEGORY_OPTIONS}
              value={category}
              onChange={(v) => setCategory((v as MarketplaceCategory) || null)}
              placeholder="All categories"
              clearable
              w={180}
            />
          </Group>

          <Chip.Group
            value={slotFilter ?? ''}
            onChange={(v) => setSlotFilter((v || null) as SlotFilter | null)}
          >
            <Group gap={6}>
              <Chip value="">All slots</Chip>
              <Chip value="model.sidebar_top">Model sidebar</Chip>
              <Chip value="model.below_images">Below images</Chip>
              <Chip value="model.actions_extra">Model actions</Chip>
            </Group>
          </Chip.Group>

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
            />
          )}
          {showRails && newItems.length > 0 && (
            <MarketplaceRail
              title="New"
              blocks={newItems}
              subsByBlock={subsByBlock}
              onOpen={handleOpen}
              earningsByAppBlockId={earningsByAppBlockId}
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
                    />
                  </Grid.Col>
                ))}
              </Grid>
              {hasNextPage && (
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
      </Container>
    </>
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
}: {
  title: string;
  blocks: AvailableBlock[];
  subsByBlock: Map<string, Partial<Record<SubscriptionScope, SubscriptionRecord>>>;
  onOpen: (block: AvailableBlock) => void;
  earningsByAppBlockId: Map<string, number>;
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
            />
          </Grid.Col>
        ))}
      </Grid>
    </Stack>
  );
}

function SubmitAppLink() {
  // v0 gate: civitai-team only. The mutation already returns UNAUTHORIZED
  // to non-mods, so the worst case if the gate slips is a clear server-
  // side rejection rather than a silent leak.
  const user = useCurrentUser();
  if (!isAppDeveloper(user)) return null;
  return (
    <Button
      component={Link}
      href="/apps/submit"
      leftSection={<IconPlus size={16} />}
      variant="light"
    >
      Submit App
    </Button>
  );
}
