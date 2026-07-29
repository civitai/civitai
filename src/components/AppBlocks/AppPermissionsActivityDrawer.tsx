import { Center, Divider, Drawer, Group, Loader, Stack, Text } from '@mantine/core';
import { IconShieldLock } from '@tabler/icons-react';
import { BlockScopeList } from '~/components/Apps/BlockScopeList';
import { AppActivityPanel } from '~/components/Apps/AppActivityPanel';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/**
 * Run-frame "Permissions & activity" surface — a per-app transparency panel
 * opened from the App Block host chrome (`AppBlockChrome` ⋯ menu). Scoped to a
 * SINGLE app (`appBlockId`), it shows the viewer:
 *
 *   1. The JWT scopes they've granted THIS app (`blocks.listMyScopeGrants`,
 *      filtered to this app, rendered via the shared `BlockScopeList` — the same
 *      component the /apps/installed "Apps & permissions" tab uses).
 *   2. A per-app action audit timeline (`AppActivityPanel` with the `appBlockId`
 *      drill-down — Buzz attribution + scope-gated call audit interleaved).
 *
 * VIEWER-SCOPED: both feeds are the current viewer's OWN data. The run page is a
 * stateless page-mint that anonymous viewers can open, so we gate the (protected)
 * queries on an authenticated session and render a friendly empty state for anon.
 *
 * The body (with its query hooks) only mounts while the drawer is `opened` — so
 * the parent chrome can render this on every run-frame without firing the queries
 * until the user actually opens the panel. (Also keeps `AppBlockChrome`'s own
 * component tests network-free: a closed drawer calls no tRPC hooks.)
 */
export function AppPermissionsActivityDrawer({
  appBlockId,
  appName,
  opened,
  onClose,
}: {
  appBlockId: string;
  appName?: string;
  opened: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="md"
      title={
        <Group gap="xs" wrap="nowrap">
          <IconShieldLock size={18} stroke={1.5} />
          <Text fw={600}>Permissions &amp; activity</Text>
        </Group>
      }
      data-testid="app-permissions-activity-drawer"
    >
      {/* Mount the query-bearing body only while open (Mantine unmounts a closed
          Drawer's children too, but gating here is explicit + keeps a closed
          chrome hook-free). */}
      {opened && <DrawerBody appBlockId={appBlockId} appName={appName} />}
    </Drawer>
  );
}

function DrawerBody({ appBlockId, appName }: { appBlockId: string; appName?: string }) {
  const currentUser = useCurrentUser();
  const isAuthed = currentUser != null;

  const grantsQuery = trpc.blocks.listMyScopeGrants.useQuery(undefined, { enabled: isAuthed });
  const grant = grantsQuery.data?.find((g) => g.appBlockId === appBlockId);

  return (
    <Stack gap="lg">
      {appName && (
        <Text size="sm" c="dimmed">
          What <strong>{appName}</strong> can do on your behalf, and what it has done recently.
          Only you can see this.
        </Text>
      )}

      <Stack gap="xs">
        <Text fw={600} size="sm">
          Granted permissions
        </Text>
        {!isAuthed ? (
          <Text size="xs" c="dimmed" fs="italic">
            Sign in to see the permissions you've granted this app.
          </Text>
        ) : grantsQuery.isLoading ? (
          <Center py="md">
            <Loader size="sm" />
          </Center>
        ) : (
          <BlockScopeList
            scopes={grant?.scopes ?? []}
            emptyLabel="You haven't granted this app any permissions yet."
          />
        )}
      </Stack>

      <Divider />

      <Stack gap="xs">
        <Text fw={600} size="sm">
          Recent activity
        </Text>
        {!isAuthed ? (
          <Text size="xs" c="dimmed" fs="italic">
            Sign in to see this app's recent activity on your account.
          </Text>
        ) : (
          // Only rendered in the authed branch, so enabled defaults to true.
          <AppActivityPanel appBlockId={appBlockId} />
        )}
      </Stack>
    </Stack>
  );
}
