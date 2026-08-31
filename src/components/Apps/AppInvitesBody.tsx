import {
  Alert,
  Badge,
  Button,
  Center,
  Group,
  List,
  Loader,
  Paper,
  Stack,
  Text,
} from '@mantine/core';
import { IconAlertTriangle, IconCoin, IconMailOpened } from '@tabler/icons-react';

import { inviteDisclosureItems } from '~/components/Apps/AppCollaboratorsPanelView';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import type { ReactNode } from 'react';
import { listingKindAppLabel } from '~/components/Apps/listingKindLabels';
import { listingEditHref } from '~/components/Apps/appListingEditorTabs';
import type { ListingKind } from '~/shared/constants/app-capabilities.constants';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * `/apps/invites` — the INVITEE's inbox, backed by `appCollaborators.listMyPendingInvites`.
 *
 * 🔴 A DEDICATED, OWNER-INDEPENDENT PAGE, and that is forced by the model rather than
 * chosen for convenience. A pending invitee owns nothing and holds no accepted seat, so
 * NO `/apps/<id>/…` authoring page is reachable for them — every one of those resolves a
 * role first and refuses. Their invitation is keyed to their own user id, so the only
 * surface that can show it is one keyed the same way.
 *
 * 🔴 IT MUST NOT CALL `appCollaborators.list`. That proc admits the listing OWNER, an
 * ACCEPTED editor, or a moderator — a PENDING invitee is refused (NOT_OWNER) by design,
 * because the roster exposes `displayed:false` seats, `invitedBy` and the timestamps.
 * `listMyPendingInvites` is the read for this page and it is scoped to `ctx.user.id`.
 */

export type PendingInviteRow = {
  appListingId: string;
  slug: string;
  kind: ListingKind;
  appBlockId: string | null;
  invitedBy: number;
  createdAt: Date | string;
};

export type AppInvitesBodyViewProps = {
  invites: PendingInviteRow[];
  isLoading?: boolean;
  errorMessage?: string | null;
  busyListingId?: string | null;
  onRespond?: (appListingId: string, accept: boolean) => void;
  /**
   * Renders the inviter's identity. INJECTED, like the roster panel's `renderUser`, so
   * this View keeps no data-layer dependency — `UserAvatar` self-fetches over tRPC, and
   * importing it here would drag that into every test of this component.
   */
  renderInviter?: (userId: number) => ReactNode;
};

/** Props-only view — no tRPC, no session, so every branch is directly renderable. */
export function AppInvitesBodyView({
  invites,
  isLoading = false,
  errorMessage = null,
  busyListingId = null,
  onRespond,
  renderInviter,
}: AppInvitesBodyViewProps) {
  const inviter =
    renderInviter ??
    ((userId: number) => (
      <Text size="xs" c="dimmed">
        user #{userId}
      </Text>
    ));
  if (errorMessage) {
    return (
      <Alert
        color="red"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        data-testid="apps-invites-error"
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
  if (invites.length === 0) {
    return (
      <Alert
        color="gray"
        variant="light"
        icon={<IconMailOpened size={16} />}
        data-testid="apps-invites-empty"
      >
        You have no pending app invitations.
      </Alert>
    );
  }
  return (
    <Stack gap="md" data-testid="apps-invites-list">
      {invites.map((invite) => {
        // 🔴 The SAME disclosure the owner saw before sending, derived from the SAME
        // table — so an invitee is told what they are accepting, kind-aware. An off-site
        // invite must not promise earnings or repo access, neither of which can exist.
        const items = inviteDisclosureItems(capabilitiesForKind(invite.kind));
        const busy = busyListingId === invite.appListingId;
        return (
          <Paper
            key={invite.appListingId}
            withBorder
            p="md"
            radius="md"
            data-testid={`apps-invite-${invite.appListingId}`}
          >
            <Stack gap="sm">
              <Group justify="space-between" wrap="wrap" gap="xs">
                <Group gap="xs">
                  <Text fw={600}>{invite.slug}</Text>
                  <Badge variant="light" color={invite.kind === 'onsite' ? 'blue' : 'grape'}>
                    {listingKindAppLabel(invite.kind)}
                  </Badge>
                </Group>
                {/* A real chip, like every sibling surface — a raw numeric id told the
                    invitee nothing about who is asking. The container supplies
                    `UserAvatar`, which self-fetches from the id, so the proc's projection
                    does not have to widen to carry a username. */}
                <Group
                  gap={4}
                  wrap="nowrap"
                  data-testid={`apps-invite-inviter-${invite.appListingId}`}
                >
                  <Text size="xs" c="dimmed">
                    Invited by
                  </Text>
                  {inviter(invite.invitedBy)}
                </Group>
              </Group>
              <Alert
                color="yellow"
                variant="light"
                icon={<IconCoin size={16} />}
                title="Accepting this invitation lets you"
                data-testid={`apps-invite-disclosure-${invite.appListingId}`}
              >
                <List size="sm" spacing={2}>
                  {items.map((item) => (
                    <List.Item key={item}>{item}</List.Item>
                  ))}
                </List>
              </Alert>
              <Group gap="xs">
                <Button
                  size="xs"
                  disabled={busy}
                  loading={busy}
                  data-testid={`apps-invite-accept-${invite.appListingId}`}
                  onClick={() => onRespond?.(invite.appListingId, true)}
                >
                  Accept
                </Button>
                <Button
                  size="xs"
                  variant="light"
                  color="red"
                  disabled={busy}
                  data-testid={`apps-invite-decline-${invite.appListingId}`}
                  onClick={() => onRespond?.(invite.appListingId, false)}
                >
                  Decline
                </Button>
              </Group>
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}

/**
 * What a settled `respondToInvite` must invalidate. PURE, and extracted from the mutation
 * callback so it is testable without a tRPC client — the callback itself is where the
 * "only on accept" bug lived, invisible to every test because only the View had any.
 *
 * 🔴 `blocks.getNavSummary` is invalidated on BOTH verdicts. It carries
 * `hasPendingInvites`, which drives the "Invites" sub-nav tab, and DECLINING is the case
 * that can take the count to zero — so gating the invalidation on `accepted` left the tab
 * pointing at an empty page until a reload, in exactly the situation where it should
 * disappear.
 */
export type InviteInvalidationKey =
  | 'appCollaborators.listMyPendingInvites'
  | 'appListings.listMine'
  | 'blocks.getNavSummary';

export function invalidationsForInviteResponse(status: string): InviteInvalidationKey[] {
  // 🔴 `status` is deliberately IGNORED, and that is the whole assertion: the set is
  // identical for accept and decline. It stays a parameter so a test can pin the two as
  // EQUAL rather than pin one and assume the other. Referenced here so the signature
  // reads as intentional to a linter without implying a branch that does not exist.
  void status;
  return [
    // The inbox itself — the responded row leaves it on either verdict.
    'appCollaborators.listMyPendingInvites',
    // "My apps" gains a row on accept; cheap and harmless to refresh on decline.
    'appListings.listMine',
    // The sub-nav counts. BOTH verdicts — see above.
    'blocks.getNavSummary',
  ];
}

/** Data container: `listMyPendingInvites` + `respondToInvite`. Never `list`. */
export function AppInvitesBody() {
  const utils = trpc.useUtils();
  const invitesQuery = trpc.appCollaborators.listMyPendingInvites.useQuery(undefined, {
    retry: false,
  });
  const respond = trpc.appCollaborators.respondToInvite.useMutation({
    onSuccess: (result) => {
      showSuccessNotification({
        message:
          result.status === 'accepted'
            ? 'Invitation accepted — the app is now in My apps.'
            : 'Invitation declined.',
      });
      // 🔴 DRIVEN FROM the exported list, not a parallel copy of it. A pure function that
      // merely DESCRIBES what the callback does is a declaration, not a code path — it
      // would pass its own test while the callback quietly invalidated something else.
      const invalidators: Record<InviteInvalidationKey, () => Promise<unknown>> = {
        'appCollaborators.listMyPendingInvites': () =>
          utils.appCollaborators.listMyPendingInvites.invalidate(),
        'appListings.listMine': () => utils.appListings.listMine.invalidate(),
        'blocks.getNavSummary': () => utils.blocks.getNavSummary.invalidate(),
      };
      for (const key of invalidationsForInviteResponse(result.status)) void invalidators[key]();
    },
    onError: (error) =>
      showErrorNotification({
        title: 'App invitation',
        error: new Error(error.message ?? 'Something went wrong.'),
      }),
  });

  return (
    <AppInvitesBodyView
      invites={(invitesQuery.data ?? []) as PendingInviteRow[]}
      isLoading={invitesQuery.isLoading}
      errorMessage={invitesQuery.error?.message ?? null}
      busyListingId={respond.isPending ? respond.variables?.appListingId ?? null : null}
      onRespond={(appListingId, accept) => respond.mutate({ appListingId, accept })}
      renderInviter={(userId) => <UserAvatar userId={userId} withUsername size="xs" />}
    />
  );
}

/** Where an accepted invite lands. Exported so the page and tests share one string. */
export function acceptedInviteHref(appListingId: string): string {
  return listingEditHref(appListingId);
}
