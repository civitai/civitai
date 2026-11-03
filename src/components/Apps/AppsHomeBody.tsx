import {
  ActionIcon,
  Anchor,
  Avatar,
  Button,
  Card,
  Grid,
  Group,
  Menu,
  Paper,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  IconBuildingStore,
  IconDotsVertical,
  IconExternalLink,
  IconEye,
  IconShieldLock,
} from '@tabler/icons-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { AppListingCard } from '~/components/Apps/AppListingCard';
import { activityTabQuery, isActivityTabVisible } from '~/components/Apps/appsActivityTabs';
import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { MyAppRow } from '~/server/services/blocks/my-apps.logic';
import {
  appInitial,
  listingPlaceholderGradient,
} from '~/shared/constants/app-listing-placeholder.constants';
import { onlyListingCards } from '~/shared/constants/app-sub-listing.constants';
import { APPS_STORE_HREF } from '~/shared/constants/apps-routes.constants';
import { canAccessAppsActivity } from '~/shared/utils/app-blocks-access';
import { trpc } from '~/utils/trpc';

/**
 * `/apps` — the signed-in viewer's app HOME ("My apps"): a launcher grid of the apps they
 * have, derived server-side by `appListings.listMyApps`. The store is `/apps/store`.
 *
 * The page (`pages/apps/index.tsx`) owns the gate: it renders this body only for a
 * signed-in viewer the store admits, so nothing here re-checks store access.
 */

/** Minimum tile width; the grid adds columns as width allows and drops to one on a phone. */
export const APPS_HOME_TILE_MIN_WIDTH = 220;
/** Skeleton tiles shown while the list loads. */
const APPS_HOME_SKELETON_TILES = 8;
/** Popular apps offered on the empty state — a small strip, not a second store. */
export const APPS_HOME_POPULAR_LIMIT = 3;
const APPS_HOME_ICON_PX = 56;

/** The deep link to the viewer's permissions for their apps. */
export const APPS_HOME_PERMISSIONS_HREF = {
  pathname: '/apps/activity',
  query: activityTabQuery('permissions'),
};

function TileGrid({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div
      data-testid={testId}
      style={{
        display: 'grid',
        gap: 16,
        // `min(100%, …)` so a phone narrower than one tile gets one full-width column
        // instead of a clipped one (the `AppsCardGrid` lesson).
        gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${APPS_HOME_TILE_MIN_WIDTH}px), 1fr))`,
      }}
    >
      {children}
    </div>
  );
}

function AppIcon({ app }: { app: Pick<MyAppRow, 'iconUrl' | 'name' | 'slug' | 'category'> }) {
  return (
    <Avatar
      src={app.iconUrl ?? undefined}
      alt=""
      radius="md"
      size={APPS_HOME_ICON_PX}
      style={{ flexShrink: 0 }}
      styles={{
        // Same seeded monogram the store card uses for a missing icon.
        placeholder: {
          background: listingPlaceholderGradient({
            slug: app.slug,
            category: app.category,
            surface: 'icon',
          }),
          color: 'var(--mantine-color-white)',
          fontWeight: 700,
        },
      }}
    >
      {appInitial(app.name, app.slug)}
    </Avatar>
  );
}

export function AppsHomeTile({
  app,
  canManagePermissions,
}: {
  app: MyAppRow;
  canManagePermissions: boolean;
}) {
  // The primary click LAUNCHES: an in-site link for a page app, a new tab for an off-site
  // one. The menu is a sibling of the link, never inside it, so the tile nests no controls.
  const launchBody = (
    <Group gap="sm" wrap="nowrap">
      <AppIcon app={app} />
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Text fw={700} lineClamp={1}>
          {app.name}
        </Text>
        {app.external && (
          <Group gap={4} wrap="nowrap">
            <IconExternalLink size={12} />
            <Text size="xs" c="dimmed">
              Opens on its own site
            </Text>
          </Group>
        )}
      </Stack>
    </Group>
  );
  const launchStyle = { flex: 1, minWidth: 0 };
  return (
    <Card padding="sm" radius={0} className="rounded-md" data-testid="apps-home-tile">
      <Group gap="sm" wrap="nowrap" align="center">
        {app.external ? (
          <Anchor
            href={app.launchHref}
            target="_blank"
            rel="noopener noreferrer"
            underline="never"
            c="inherit"
            aria-label={`Open ${app.name} (opens in a new tab)`}
            data-testid="apps-home-tile-launch"
            style={launchStyle}
          >
            {launchBody}
          </Anchor>
        ) : (
          <Anchor
            component={Link}
            href={app.launchHref}
            underline="never"
            c="inherit"
            aria-label={`Open ${app.name}`}
            data-testid="apps-home-tile-launch"
            style={launchStyle}
          >
            {launchBody}
          </Anchor>
        )}
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label={`More options for ${app.name}`}
              data-testid="apps-home-tile-menu"
            >
              <IconDotsVertical size={16} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {canManagePermissions && (
              <Menu.Item
                component={Link}
                href={APPS_HOME_PERMISSIONS_HREF}
                leftSection={<IconShieldLock size={14} />}
                data-testid="apps-home-tile-permissions"
              >
                Manage permissions
              </Menu.Item>
            )}
            <Menu.Item
              component={Link}
              href={getListingDetailHref(app.slug)}
              leftSection={<IconEye size={14} />}
              data-testid="apps-home-tile-store"
            >
              View in store
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
    </Card>
  );
}

function BrowseStoreButton({ testId }: { testId: string }) {
  return (
    <Button
      component={Link}
      href={APPS_STORE_HREF}
      leftSection={<IconBuildingStore size={16} />}
      data-testid={testId}
    >
      Browse the store
    </Button>
  );
}

function PopularStrip({ canOpenPage }: { canOpenPage: boolean }) {
  // The store's own list read, popular-first, a handful of cards. No new query.
  const popular = trpc.appListings.listAvailable.useQuery({
    sort: 'popular',
    limit: APPS_HOME_POPULAR_LIMIT,
  });
  const cards = onlyListingCards(popular.data?.items ?? []).slice(0, APPS_HOME_POPULAR_LIMIT);
  if (!cards.length) return null;
  return (
    <Stack gap="xs" component="section" aria-label="Popular apps" data-testid="apps-home-popular">
      <Title order={4}>Popular apps</Title>
      <Grid gutter="md">
        {cards.map((card) => (
          <Grid.Col key={card.id} span={{ base: 12, sm: 6, md: 4 }}>
            <AppListingCard card={card} canOpenPage={canOpenPage} />
          </Grid.Col>
        ))}
      </Grid>
    </Stack>
  );
}

function EmptyState({ canOpenPage }: { canOpenPage: boolean }) {
  return (
    <Stack gap="xl">
      <Paper p="xl" radius="md" withBorder data-testid="apps-home-empty">
        <Stack align="center" gap="sm">
          <IconBuildingStore size={40} stroke={1.5} />
          <Title order={3} ta="center">
            No apps yet
          </Title>
          <Text c="dimmed" ta="center" maw={480}>
            Apps you open, connect or buy show up here, so you can get back to them in one click.
            Find something to try in the store.
          </Text>
          <BrowseStoreButton testId="apps-home-empty-browse" />
        </Stack>
      </Paper>
      <PopularStrip canOpenPage={canOpenPage} />
    </Stack>
  );
}

export function AppsHomeBody() {
  const features = useFeatureFlags();
  const myApps = trpc.appListings.listMyApps.useQuery();
  // "Manage permissions" deep-links to a tab only the slot flag shows, on a page only the
  // activity gate admits. Offer it only where both would render it.
  const canManagePermissions =
    canAccessAppsActivity(features) &&
    isActivityTabVisible('permissions', { canSeeSlotGatedTabs: !!features.appBlocks });
  const canOpenPage = !!features.appBlocksPages;
  const apps = myApps.data ?? [];

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <Title order={1} size="h2">
          My apps
        </Title>
        <BrowseStoreButton testId="apps-home-browse" />
      </Group>

      {myApps.isLoading ? (
        <TileGrid testId="apps-home-skeleton">
          {Array.from({ length: APPS_HOME_SKELETON_TILES }, (_, i) => (
            <Skeleton key={i} height={APPS_HOME_ICON_PX + 24} radius="md" />
          ))}
        </TileGrid>
      ) : myApps.isError ? (
        <Paper p="lg" radius="md" withBorder data-testid="apps-home-error">
          <Stack gap="xs" align="flex-start">
            <Text>We couldn&apos;t load your apps.</Text>
            <Button variant="default" size="xs" onClick={() => void myApps.refetch()}>
              Try again
            </Button>
          </Stack>
        </Paper>
      ) : apps.length === 0 ? (
        <EmptyState canOpenPage={canOpenPage} />
      ) : (
        <TileGrid testId="apps-home-grid">
          {apps.map((app) => (
            <AppsHomeTile
              key={app.listingId}
              app={app}
              canManagePermissions={canManagePermissions}
            />
          ))}
        </TileGrid>
      )}
    </Stack>
  );
}
