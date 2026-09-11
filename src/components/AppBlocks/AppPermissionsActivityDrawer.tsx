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
 *      component the /apps/activity "Apps & permissions" tab uses).
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
 *
 * 🔴 THE FEED'S `App` COLUMN IS PLAIN TEXT HERE, NOT A STORE LINK, AND THAT IS A DECISION
 * RATHER THAN AN OMISSION. `AppActivityPanel` gained a link from the app name to
 * `/apps/store-preview/<slug>`; this drawer is mounted OVER A RUNNING FULL-PAGE APP, so
 * that link would be a TOP-LEVEL navigation out of whatever the user was doing inside it
 * — triggered from a panel they opened to read, with no warning and no way back to their
 * in-app state. The panel suppresses it whenever it is in per-app drill-down mode
 * (`linkable={!appBlockId}`), which is exactly the mode this drawer uses; the column is a
 * label there anyway, since every row is the same app. Not a `target="_blank"`: a second
 * rendering of one column is how the two come to disagree. Pinned by
 * `AppPermissionsActivityDrawer.browser.test.tsx`.
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
          The permissions <strong>{appName}</strong> carries through your own installs, and what it
          has done recently. Only you can see this.
        </Text>
      )}

      <Stack gap="xs">
        {/* "…from your installs", not "Granted permissions" — the section's only source is
            install-backed, so the wider heading was the same overstatement as the empty
            label it sits above. */}
        <Text fw={600} size="sm">
          Permissions from your installs
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
          /* 🔴 THE EMPTY LABEL IS NOT "no permissions granted", AND THE PANEL BELOW IS WHY.
             `grant` is `grants.find(g => g.appBlockId === appBlockId)` over
             `listMyScopeGrants`, whose only source is the viewer's OWN
             `block_user_subscriptions` rows. A full-page app has no install, so that lookup
             is `undefined` for every such app — and the drawer then claimed the viewer had
             granted it nothing WHILE `AppActivityPanel` a few lines down listed the
             scope-gated calls that same app had just made, possibly minutes after they
             accepted its consent modal. Two halves of one drawer contradicting each other.
             Absence of an install-backed row is not absence of granted permission; the label
             says which of the two it is and sends the reader to the half that knows. */
          <BlockScopeList
            scopes={grant?.scopes ?? []}
            emptyLabel="No permissions recorded from an install of this app — which is not the same as no access. Anything it has actually done on your account is listed under Recent activity below."
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
