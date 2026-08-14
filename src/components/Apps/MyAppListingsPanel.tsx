import { Alert, Badge, Center, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconApps } from '@tabler/icons-react';
import Link from 'next/link';

import type { EditorTab } from '~/components/Apps/appListingEditorTabs';
import { editorTabsFor, listingEditHref } from '~/components/Apps/appListingEditorTabs';
import type {
  AppRole,
  ListingCapability,
  ListingKind,
} from '~/shared/constants/app-capabilities.constants';
import { isAuthorableListingStatus } from '~/shared/constants/app-capabilities.constants';
import { trpc } from '~/utils/trpc';

/**
 * "My apps" — every listing the caller OWNS or holds an ACCEPTED editor seat on.
 *
 * 🔴 THIS IS THE SURFACE THE COLLABORATOR FEATURE HAD NO BACKING READ FOR. Before
 * `appListings.listMine` (→ `listMyAppListings` → `resolveAccessibleListingIds`) the only
 * "my stuff" read was `listMySubmissions`, scoped to a publish request's
 * `submittedByUserId` — which answers neither ownership nor seats. A collaborator has
 * submitted nothing, so every pre-existing App Blocks surface was empty for them and the
 * app they had just accepted a seat on was unreachable from anywhere in the product.
 */

export type MyAppListingRow = {
  appListingId: string;
  slug: string;
  name: string;
  status: string;
  kind: ListingKind;
  appBlockId: string | null;
  role: AppRole;
  capabilities: Readonly<Record<ListingCapability, boolean>>;
};

export type MyAppListingsPanelViewProps = {
  rows: MyAppListingRow[];
  isLoading?: boolean;
  errorMessage?: string | null;
};

/**
 * 🔴 THE ROW LINKS TO A TAB THE ROW'S OWN KIND ALLOWS. `editorTabsFor` is the single
 * derivation, so a card can never deep-link an off-site listing at `?tab=manifest` — the
 * href is built from the same list the destination page will render.
 *
 * 🔴 AND THAT IS A WEAKER CLAIM THAN IT LOOKS, stated honestly because an earlier version
 * of this comment overclaimed: `tabs[0]` is `'details'` for EVERY shape, since Details is
 * the one tab every kind and role can always open. So this call currently cannot produce a
 * kind-specific href, and a test asserting "never `?tab=manifest` for off-site" passes
 * whatever the capability table says. It is written this way so it STAYS correct if the
 * first tab ever becomes conditional — not because it is doing work today. The real
 * kind-derivation guard is `appListingEditorTabs.test.ts`.
 */
export function myAppListingHref(row: MyAppListingRow): string {
  const tabs: EditorTab[] = editorTabsFor({
    kind: row.kind,
    appBlockId: row.appBlockId,
    role: row.role,
    capabilities: row.capabilities,
  });
  return listingEditHref(row.appListingId, tabs[0]);
}

export function MyAppListingsPanelView({
  rows,
  isLoading = false,
  errorMessage = null,
}: MyAppListingsPanelViewProps) {
  if (errorMessage) {
    return (
      <Alert
        color="red"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        data-testid="apps-mine-error"
      >
        {errorMessage}
      </Alert>
    );
  }
  if (isLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (rows.length === 0) {
    return (
      <Alert
        color="gray"
        variant="light"
        icon={<IconApps size={16} />}
        data-testid="apps-mine-empty"
      >
        You don’t own or collaborate on any apps yet.
      </Alert>
    );
  }
  return (
    <Stack gap="sm" data-testid="apps-mine-list">
      {rows.map((row) => (
        <Paper
          key={row.appListingId}
          withBorder
          p="md"
          radius="md"
          data-testid={`apps-mine-row-${row.appListingId}`}
        >
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Stack gap={2}>
              {/* 🔴 NO LINK when the editor would refuse. `getAppListingAuthoringContext`
                  throws FORBIDDEN on a non-authorable status (a moderator-REMOVED or a
                  REJECTED listing), so linking there would be offering a guaranteed 403 —
                  and on a removed listing the page used to open with a fully live
                  Collaborators tab. The row still LISTS, because an owner needs to see
                  that the app exists and what became of it. */}
              {isAuthorableListingStatus(row.status) ? (
                <Link
                  href={myAppListingHref(row)}
                  data-testid={`apps-mine-link-${row.appListingId}`}
                >
                  <Text fw={600}>{row.name}</Text>
                </Link>
              ) : (
                <Text fw={600} c="dimmed" data-testid={`apps-mine-unlinked-${row.appListingId}`}>
                  {row.name}
                </Text>
              )}
              <Text size="xs" c="dimmed">
                {row.slug}
              </Text>
            </Stack>
            <Group gap="xs">
              <Badge variant="light" color={row.kind === 'onsite' ? 'blue' : 'grape'}>
                {row.kind === 'onsite' ? 'On-site' : 'External'}
              </Badge>
              {/* 🔴 The role badge is not decoration: an editor cannot invite, remove or
                  transfer, so saying which one they are is what makes the missing
                  controls legible rather than looking broken. */}
              <Badge
                variant="filled"
                color={row.role === 'owner' ? 'teal' : 'indigo'}
                data-testid={`apps-mine-role-${row.appListingId}`}
              >
                {row.role === 'owner' ? 'Owner' : 'Collaborator'}
              </Badge>
              <Badge variant="outline" color="gray">
                {row.status}
              </Badge>
            </Group>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}

export function MyAppListingsPanel() {
  const query = trpc.appListings.listMine.useQuery(undefined, { retry: false });
  return (
    <MyAppListingsPanelView
      rows={(query.data ?? []) as MyAppListingRow[]}
      isLoading={query.isLoading}
      errorMessage={query.error?.message ?? null}
    />
  );
}
