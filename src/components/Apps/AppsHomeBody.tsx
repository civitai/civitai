import {
  ActionIcon,
  Anchor,
  Avatar,
  Button,
  CloseButton,
  Group,
  Paper,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { Menu } from '~/components/MantineOverlays';
import {
  IconBuildingStore,
  IconDotsVertical,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconShieldLock,
} from '@tabler/icons-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { chromeRecentAppIconSrc } from '~/components/AppBlocks/chromeRecentAppIconSrc';
import { useChromeListingDetail } from '~/components/AppBlocks/useChromeListingDetail';
import {
  homeEmptyKind,
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
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * `/apps` — the signed-in viewer's "My apps" launcher grid (`listMyApps` merged with this
 * browser's recents by `mergeHomeApps`). The page owns the store-access gate; this body does
 * not re-check it.
 */

const APPS_HOME_SKELETON_TILES = 8;
export const APPS_HOME_ICON_PX = 60;
/** A launcher-icon corner radius. */
const APPS_HOME_ICON_RADIUS = 14;
const APPS_HOME_UNDO_MS = 8000;

/** The deep link to the viewer's permissions for their apps. */
export const APPS_HOME_PERMISSIONS_HREF = {
  pathname: '/apps/activity',
  query: activityTabQuery('permissions'),
};

/**
 * Fixed-width tiles packed from the left, so two apps sit side by side instead of stretching
 * across the page. 96px tiles with a 16px gap on a phone (three fit at 360px wide), 104px with
 * a 20px gap from `sm`. The name truncates, so a long one cannot widen its column.
 */
function TileGrid({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div
      data-testid={testId}
      className="grid grid-cols-[repeat(auto-fill,96px)] justify-start gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,104px)] sm:gap-x-5"
    >
      {children}
    </div>
  );
}

type IconProps = { app: Pick<AppsHomeTileModel, 'name' | 'slug' | 'category'>; src: string | null };

/** The app icon — the same seeded letter avatar the store card and detail page use when an
 *  app has no icon (`listingPlaceholderGradient` + `appInitial`). */
function AppIcon({ app, src }: IconProps) {
  return (
    <Avatar
      src={src ?? undefined}
      data-testid="apps-home-tile-icon"
      // The resolved source, readable even after a failed image load swaps in the monogram.
      data-icon-src={src ?? ''}
      alt=""
      radius={APPS_HOME_ICON_RADIUS}
      size={APPS_HOME_ICON_PX}
      style={{ flexShrink: 0 }}
      styles={{
        placeholder: {
          background: listingPlaceholderGradient({
            slug: app.slug,
            category: app.category,
            surface: 'icon',
          }),
          color: 'var(--mantine-color-white)',
          fontWeight: 700,
          fontSize: 24,
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
  onRemove,
}: {
  app: AppsHomeTileModel;
  canManagePermissions: boolean;
  /** Records an off-site launch — following the link leaves the SPA, so this is the only chance. */
  onLaunchExternal?: (recent: RecentApp) => void;
  /** "Remove from My apps". */
  onRemove?: (app: AppsHomeTileModel) => void;
}) {
  // The primary click LAUNCHES: an in-site link for a page app, a new tab for an off-site
  // one. The ⋮ menu is a sibling of the link, never inside it, so the tile nests no controls.
  // The name is one line, truncated; the full name is the link's `title` (hover) and is in
  // its accessible name.
  const launchBody = (
    <>
      <div style={{ position: 'relative' }}>
        {app.iconFromServer ? <AppIcon app={app} src={app.iconUrl} /> : <LiveAppIcon app={app} />}
        {app.external && (
          <span
            aria-hidden
            data-testid="apps-home-tile-external"
            className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full border border-solid border-gray-3 bg-white text-gray-7 dark:border-dark-4 dark:bg-dark-6 dark:text-dark-0"
          >
            <IconExternalLink size={12} />
          </span>
        )}
      </div>
      <Text
        size="xs"
        fw={500}
        ta="center"
        truncate="end"
        w="100%"
        data-testid="apps-home-tile-name"
      >
        {app.name}
      </Text>
    </>
  );
  const launchClass =
    'flex w-full min-w-0 flex-col items-center gap-1.5 rounded-lg px-1 py-1.5 hover:bg-gray-0 dark:hover:bg-dark-6';
  return (
    <div data-testid="apps-home-tile" data-source={app.source} className="group relative min-w-0">
      {app.external ? (
        <Anchor
          href={app.launchHref}
          target="_blank"
          rel="noopener noreferrer"
          underline="never"
          c="inherit"
          title={app.name}
          aria-label={`Open ${app.name} (opens in a new tab)`}
          data-testid="apps-home-tile-launch"
          onClick={() => onLaunchExternal?.(app.recent)}
          className={launchClass}
        >
          {launchBody}
        </Anchor>
      ) : (
        <Anchor
          component={Link}
          href={app.launchHref}
          underline="never"
          c="inherit"
          title={app.name}
          aria-label={`Open ${app.name}`}
          data-testid="apps-home-tile-launch"
          className={launchClass}
        >
          {launchBody}
        </Anchor>
      )}
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon
            variant="default"
            radius="xl"
            size="sm"
            aria-label={`More options for ${app.name}`}
            data-testid="apps-home-tile-menu"
            // Revealed on hover and on keyboard focus with a fine pointer; ALWAYS shown on a
            // touch screen (no hover there), and while its menu is open. It stays in the tab
            // order throughout, so a keyboard user reaches it right after the launch link.
            className="absolute right-0 top-0 opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-[expanded=true]:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <IconDotsVertical size={14} />
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
          {onRemove && (
            <Menu.Item
              leftSection={<IconEyeOff size={14} />}
              onClick={() => onRemove(app)}
              data-testid="apps-home-tile-remove"
            >
              Remove from My apps
            </Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
    </div>
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

/**
 * The empty home. `all-removed` — the viewer has apps but removed every one — must not claim
 * "No apps yet"; it says what happened and how they come back (`homeEmptyKind`).
 */
function EmptyState({ kind }: { kind: 'no-apps' | 'all-removed' }) {
  return (
    <Paper p="xl" radius="md" withBorder data-testid="apps-home-empty" data-empty-kind={kind}>
      <Stack align="center" gap="sm">
        <IconBuildingStore size={40} stroke={1.5} />
        <Title order={3} ta="center">
          {kind === 'all-removed' ? "You've removed all your apps from this page" : 'No apps yet'}
        </Title>
        <Text c="dimmed" ta="center" maw={480}>
          {kind === 'all-removed'
            ? 'Apps you open again will come back here.'
            : 'Apps you open, connect or buy show up here, so you can get back to them in one click. Find something to try in the store.'}
        </Text>
        <BrowseStoreButton testId="apps-home-empty-browse" />
      </Stack>
    </Paper>
  );
}

/**
 * The "Removed … from My apps · Undo" bar. Rendered INSIDE the home's always-mounted
 * `role="status"` region (a live region inserted together with its content is not reliably
 * announced). The Undo button takes focus when it appears: the menu item that was focused is
 * gone with its tile, so this is where a keyboard user's focus lands instead of the page body.
 */
function RemovedBar({
  name,
  onUndo,
  onDismiss,
}: {
  name: string;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const undoRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    undoRef.current?.focus();
  }, [name]);
  return (
    <Paper p="xs" radius="md" withBorder data-testid="apps-home-removed">
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text size="sm" lineClamp={1} style={{ minWidth: 0 }}>
          Removed {name} from My apps
        </Text>
        <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
          <Button
            ref={undoRef}
            size="xs"
            variant="subtle"
            onClick={onUndo}
            aria-label={`Undo removing ${name}`}
            data-testid="apps-home-undo"
          >
            Undo
          </Button>
          <CloseButton size="sm" aria-label="Dismiss" onClick={onDismiss} />
        </Group>
      </Group>
    </Paper>
  );
}

/** Local hide state layered over the server's: an ISO time = hidden, `null` = un-hidden. */
type HiddenOverrides = Record<string, string | null>;

export function AppsHomeBody() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const myApps = trpc.appListings.listMyApps.useQuery();
  const hideMutation = trpc.appListings.hideMyApp.useMutation();
  const unhideMutation = trpc.appListings.unhideMyApp.useMutation();
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

  // ── "Remove from My apps", optimistic ────────────────────────────────────────
  // A removal hides the tile at once (a local override), then persists. On failure the
  // override is dropped, so the grid falls back to the cached server state — which never had
  // the hide — and the tile returns. A failed Undo instead re-applies the hide (see below).
  //
  // Don't refetch while an Undo is offered: the server drops hidden rows from `listMyApps`, so
  // a refetch would evict the row Undo restores. The owed refetch runs once the bar closes.
  const [overrides, setOverrides] = useState<HiddenOverrides>({});
  const [removed, setRemoved] = useState<{ slug: string; name: string; hiddenAt: string } | null>(
    null
  );
  // An Undo waits for its own hide to settle, and a re-remove for the Undo's unhide, so the
  // writes for one slug reach the server in the order they were made.
  const pendingHides = useRef(new Map<string, Promise<unknown>>());
  const pendingUnhides = useRef(new Map<string, Promise<unknown>>());
  // Every hide/unhide still in flight (settled-only, never rejecting); the refetch waits on them.
  const inFlight = useRef(new Set<Promise<unknown>>());
  const refetchOwed = useRef(false);
  const barOpen = useRef(false);
  barOpen.current = removed !== null;

  function track(write: Promise<unknown>) {
    const settled = write.then(
      () => undefined,
      () => undefined
    );
    inFlight.current.add(settled);
    void settled.then(() => inFlight.current.delete(settled));
    refetchOwed.current = true;
    return settled;
  }

  /** Run the owed refetch, unless a bar (an open Undo window) still needs the cached rows. */
  function flushRefetch() {
    if (!refetchOwed.current) return;
    refetchOwed.current = false;
    void Promise.all([...inFlight.current]).then(() => {
      // A removal made while the writes settled reopened a window: wait for that one instead.
      if (barOpen.current) refetchOwed.current = true;
      else void utils.appListings.listMyApps.invalidate();
    });
  }
  const flushRef = useRef(flushRefetch);
  flushRef.current = flushRefetch;

  useEffect(() => {
    if (!removed) flushRef.current();
  }, [removed]);
  // Leaving mid-window still owes the refetch: the cache outlives this page, and the next
  // visit would otherwise show the removed app again. (`invalidate` is not component state.)
  useEffect(
    () => () => {
      barOpen.current = false;
      flushRef.current();
    },
    []
  );

  /** Drop `slug`'s override, but only if it still holds the value this action set. */
  function dropOverride(slug: string, expected: string | null) {
    setOverrides((prev) => {
      if (!(slug in prev) || prev[slug] !== expected) return prev;
      const next = { ...prev };
      delete next[slug];
      return next;
    });
  }

  async function handleRemove(app: AppsHomeTileModel) {
    const optimistic = new Date().toISOString();
    setOverrides((prev) => ({ ...prev, [app.slug]: optimistic }));
    setRemoved({ slug: app.slug, name: app.name, hiddenAt: optimistic });
    // Remove → Undo → remove again before the unhide settles: sent at once, the hide could
    // land first and the unhide after it, leaving the server unhidden under a removed tile.
    const unhide = pendingUnhides.current.get(app.slug);
    const write = unhide
      ? unhide.then(() => hideMutation.mutateAsync({ slug: app.slug }))
      : hideMutation.mutateAsync({ slug: app.slug });
    pendingHides.current.set(app.slug, track(write));
    try {
      await write;
    } catch (error) {
      dropOverride(app.slug, optimistic);
      closeRemovedBar(app.slug);
      showErrorNotification({
        title: `Couldn't remove ${app.name}`,
        error: error instanceof Error ? error : { message: 'Please try again.' },
      });
    }
  }

  async function handleUndo() {
    if (!removed) return;
    const { slug, name, hiddenAt } = removed;
    // No refetch has run, so the row is still cached: clearing the hide puts the tile back
    // at once, in its place.
    setOverrides((prev) => ({ ...prev, [slug]: null }));
    const write = (async () => {
      await pendingHides.current.get(slug);
      return unhideMutation.mutateAsync({ slug });
    })();
    const settled = track(write);
    pendingUnhides.current.set(slug, settled);
    void settled.then(() => {
      if (pendingUnhides.current.get(slug) === settled) pendingUnhides.current.delete(slug);
    });
    // Closing the bar flushes the owed refetch, which waits for this unhide to settle.
    closeRemovedBar();
    try {
      await write;
    } catch (error) {
      // The server still holds the hide. Restore it rather than fall back to the cached
      // state, which predates the hide and would keep showing the app.
      setOverrides((prev) => (prev[slug] === null ? { ...prev, [slug]: hiddenAt } : prev));
      showErrorNotification({
        title: `Couldn't restore ${name}`,
        error: error instanceof Error ? error : { message: 'Please try again.' },
      });
    }
  }

  // The bar's auto-dismiss PAUSES while the pointer is over it or focus is inside it (a timed
  // control must not vanish under the user), and restarts in full when they leave. Focus lands
  // on Undo when the bar appears, so a keyboard user's bar stays until they move on.
  const statusRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [barHovered, setBarHovered] = useState(false);
  const [barFocused, setBarFocused] = useState(false);
  const barPaused = barHovered || barFocused;
  // Set when the bar closes with focus inside it, so focus goes to the page heading rather
  // than falling to <body> with the unmounted button.
  const refocusHeading = useRef(false);

  /**
   * Close the bar (only if it is showing `onlyFor`, when given); if focus was inside it, hand
   * focus to the heading once it is gone. The ref write in the updater is idempotent, so a
   * double-invoked updater is harmless.
   */
  function closeRemovedBar(onlyFor?: string) {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    const focusInside = !!active && !!statusRef.current?.contains(active);
    setRemoved((prev) => {
      if (!prev || (onlyFor !== undefined && prev.slug !== onlyFor)) return prev;
      if (focusInside) refocusHeading.current = true;
      return null;
    });
  }

  useEffect(() => {
    if (removed) return;
    setBarHovered(false);
    setBarFocused(false);
    if (refocusHeading.current) {
      refocusHeading.current = false;
      headingRef.current?.focus();
    }
  }, [removed]);

  useEffect(() => {
    if (!removed || barPaused) return;
    const timer = setTimeout(() => setRemoved(null), APPS_HOME_UNDO_MS);
    return () => clearTimeout(timer);
  }, [removed, barPaused]);

  const serverHidden = myApps.data?.hidden;
  const hidden = useMemo(() => {
    const merged: Record<string, string> = { ...(serverHidden ?? {}) };
    for (const [slug, value] of Object.entries(overrides)) {
      if (value === null) delete merged[slug];
      else merged[slug] = value;
    }
    return merged;
  }, [serverHidden, overrides]);

  const tiles = useMemo(
    () =>
      mergeHomeApps({
        server: myApps.data?.apps ?? [],
        recents,
        canOpenPage,
        hidden,
        removedSlugsByListingId: myApps.data?.removedSlugsByListingId,
      }),
    [myApps.data?.apps, myApps.data?.removedSlugsByListingId, recents, canOpenPage, hidden]
  );

  return (
    <Stack gap="lg">
      {/* The heading and the status region share one stack whose gap exists only while the bar
          shows, so the always-mounted (empty) region adds no space when idle. */}
      <Stack gap={removed ? 'lg' : 0}>
        <Group justify="space-between" align="center" wrap="wrap" gap="sm">
          <Title order={1} size="h2" ref={headingRef} tabIndex={-1}>
            My apps
          </Title>
          <BrowseStoreButton testId="apps-home-browse" />
        </Group>

        {/* Always mounted, empty when idle, so the removal message is announced. */}
        <div
          ref={statusRef}
          role="status"
          data-testid="apps-home-removed-status"
          onMouseEnter={() => setBarHovered(true)}
          onMouseLeave={() => setBarHovered(false)}
          onFocus={() => setBarFocused(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setBarFocused(false);
          }}
        >
          {removed && (
            <RemovedBar
              name={removed.name}
              onUndo={() => void handleUndo()}
              onDismiss={() => closeRemovedBar()}
            />
          )}
        </div>
      </Stack>

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
            <Stack key={i} align="center" gap={6}>
              <Skeleton
                height={APPS_HOME_ICON_PX}
                width={APPS_HOME_ICON_PX}
                radius={APPS_HOME_ICON_RADIUS}
              />
              <Skeleton height={10} width="70%" radius="sm" />
            </Stack>
          ))}
        </TileGrid>
      ) : tiles.length === 0 ? (
        // Empty only when BOTH sources are: nothing from the server AND no local recents.
        myApps.isError ? null : (
          <EmptyState
            kind={homeEmptyKind({
              server: myApps.data?.apps ?? [],
              recents,
              canOpenPage,
              hidden,
              removedSlugsByListingId: myApps.data?.removedSlugsByListingId,
              removedCount: myApps.data?.removedCount,
            })}
          />
        )
      ) : (
        <TileGrid testId="apps-home-grid">
          {tiles.map((app) => (
            <AppsHomeTile
              key={app.key}
              app={app}
              canManagePermissions={canManagePermissions}
              onLaunchExternal={handleLaunchExternal}
              onRemove={(a) => void handleRemove(a)}
            />
          ))}
        </TileGrid>
      )}
    </Stack>
  );
}
