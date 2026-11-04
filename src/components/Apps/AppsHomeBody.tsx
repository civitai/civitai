import {
  ActionIcon,
  Anchor,
  Avatar,
  Button,
  Card,
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
import { useEffect, useMemo, useState } from 'react';

import { chromeRecentAppIconSrc } from '~/components/AppBlocks/chromeRecentAppIconSrc';
import { useChromeListingDetail } from '~/components/AppBlocks/useChromeListingDetail';
import {
  mergeHomeApps,
  type AppsHomeTile as AppsHomeTileModel,
} from '~/components/Apps/appsHomeMerge';
import {
  getRecentlyOpenedApps,
  recordRecentlyOpenedApp,
  type RecentApp,
} from '~/components/Apps/recentlyOpenedAppsStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { activityTabQuery, isActivityTabVisible } from '~/components/Apps/appsActivityTabs';
import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  appInitial,
  listingPlaceholderGradient,
} from '~/shared/constants/app-listing-placeholder.constants';
import { APPS_STORE_HREF } from '~/shared/constants/apps-routes.constants';
import { canAccessAppsActivity } from '~/shared/utils/app-blocks-access';
import { trpc } from '~/utils/trpc';

/**
 * `/apps` — the signed-in viewer's app HOME ("My apps"): a launcher grid of the apps they
 * have — the server-derived list (`appListings.listMyApps`) merged with this browser's
 * "Recently opened" store for the current account (`mergeHomeApps`, which owns the order and
 * the dedupe). The store is `/apps/store`.
 *
 * The page (`pages/apps/index.tsx`) owns the gate: it renders this body only for a
 * signed-in viewer the store admits, so nothing here re-checks store access.
 */

/** Minimum tile width; the grid adds columns as width allows and drops to one on a phone. */
export const APPS_HOME_TILE_MIN_WIDTH = 220;
/** Skeleton tiles shown while the list loads. */
const APPS_HOME_SKELETON_TILES = 8;
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

type IconProps = { app: Pick<AppsHomeTileModel, 'name' | 'slug' | 'category'>; src: string | null };

function AppIcon({ app, src }: IconProps) {
  return (
    <Avatar
      src={src ?? undefined}
      data-testid="apps-home-tile-icon"
      // The resolved source, readable even after a failed image load swaps in the monogram.
      data-icon-src={src ?? ''}
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

/**
 * A recents-only tile's icon, resolved LIVE: the recents store never persists an icon url, so
 * this asks the server for the listing exactly as the app chrome's "Recently run" menu does
 * (`useChromeListingDetail` + `chromeRecentAppIconSrc`) and falls back to the monogram while
 * loading, on error, and whenever the media gate hides the icon from this viewer.
 */
function LiveAppIcon({ app }: { app: IconProps['app'] }) {
  return <AppIcon app={app} src={chromeRecentAppIconSrc(useChromeListingDetail(app.slug))} />;
}

export function AppsHomeTile({
  app,
  canManagePermissions,
  onLaunchExternal,
}: {
  app: AppsHomeTileModel;
  canManagePermissions: boolean;
  /** Records an off-site launch — following the link leaves the SPA, so this is the only chance. */
  onLaunchExternal?: (recent: RecentApp) => void;
}) {
  // The primary click LAUNCHES: an in-site link for a page app, a new tab for an off-site
  // one. The menu is a sibling of the link, never inside it, so the tile nests no controls.
  const launchBody = (
    <Group gap="sm" wrap="nowrap">
      {app.iconFromServer ? <AppIcon app={app} src={app.iconUrl} /> : <LiveAppIcon app={app} />}
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
    <Card
      padding="sm"
      radius={0}
      className="rounded-md"
      data-testid="apps-home-tile"
      data-source={app.source}
    >
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
            onClick={() => onLaunchExternal?.(app.recent)}
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

function EmptyState() {
  return (
    <Paper p="xl" radius="md" withBorder data-testid="apps-home-empty">
      <Stack align="center" gap="sm">
        <IconBuildingStore size={40} stroke={1.5} />
        <Title order={3} ta="center">
          No apps yet
        </Title>
        <Text c="dimmed" ta="center" maw={480}>
          Apps you open, connect or buy show up here, so you can get back to them in one click. Find
          something to try in the store.
        </Text>
        <BrowseStoreButton testId="apps-home-empty-browse" />
      </Stack>
    </Paper>
  );
}

export function AppsHomeBody() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const myApps = trpc.appListings.listMyApps.useQuery();
  // "Manage permissions" deep-links to a tab only the slot flag shows, on a page only the
  // activity gate admits. Offer it only where both would render it.
  const canManagePermissions =
    canAccessAppsActivity(features) &&
    isActivityTabVisible('permissions', { canSeeSlotGatedTabs: !!features.appBlocks });
  const canOpenPage = !!features.appBlocksPages;

  // "Recently opened" (client-only, from localStorage), read the way the store used to:
  // SEEDED EMPTY so the server render and the first client render match — reading
  // localStorage during render is a hydration mismatch — and loaded after mount. Keyed by
  // ACCOUNT: the store returns only what the current viewer wrote, and `ownerId` is a dep so
  // an in-SPA sign-in / switch re-reads rather than showing the previous account's apps.
  const ownerId = currentUser?.id ?? null;
  const [recents, setRecents] = useState<RecentApp[]>([]);
  useEffect(() => {
    setRecents(getRecentlyOpenedApps(ownerId));
  }, [ownerId]);
  // Following an off-site link leaves the SPA, so the click is the only chance to record it
  // (an on-site launch is recorded by the run page itself). Moves the app to the front.
  function handleLaunchExternal(recent: RecentApp) {
    setRecents(recordRecentlyOpenedApp(recent, ownerId));
  }

  const tiles = useMemo(
    () => mergeHomeApps({ server: myApps.data ?? [], recents, canOpenPage }),
    [myApps.data, recents, canOpenPage]
  );

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <Title order={1} size="h2">
          My apps
        </Title>
        <BrowseStoreButton testId="apps-home-browse" />
      </Group>

      {myApps.isError && (
        <Paper p="lg" radius="md" withBorder data-testid="apps-home-error">
          <Stack gap="xs" align="flex-start">
            <Text>We couldn&apos;t load all of your apps.</Text>
            <Button variant="default" size="xs" onClick={() => void myApps.refetch()}>
              Try again
            </Button>
          </Stack>
        </Paper>
      )}

      {myApps.isLoading ? (
        <TileGrid testId="apps-home-skeleton">
          {Array.from({ length: APPS_HOME_SKELETON_TILES }, (_, i) => (
            <Skeleton key={i} height={APPS_HOME_ICON_PX + 24} radius="md" />
          ))}
        </TileGrid>
      ) : tiles.length === 0 ? (
        // Empty only when BOTH sources are: nothing from the server AND no local recents.
        myApps.isError ? null : (
          <EmptyState />
        )
      ) : (
        <TileGrid testId="apps-home-grid">
          {tiles.map((app) => (
            <AppsHomeTile
              key={app.key}
              app={app}
              canManagePermissions={canManagePermissions}
              onLaunchExternal={handleLaunchExternal}
            />
          ))}
        </TileGrid>
      )}
    </Stack>
  );
}
