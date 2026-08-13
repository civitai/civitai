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
  Switch,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconCoin, IconInfoCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { constants } from '~/server/common/constants';
import type { AppRole, ListingCapability } from '~/shared/constants/app-capabilities.constants';

/**
 * App Listing COLLABORATORS — the PRESENTATIONAL roster panel.
 *
 * 🔴 IN ITS OWN FILE, AND THAT SPLIT IS STRUCTURAL RATHER THAN STYLISTIC. The data
 * container next door imports `QuickSearchDropdown`, whose module graph reaches a
 * Meilisearch client that reads its host URL AT IMPORT TIME — so any test file that
 * touches it dies with `Provided hostUrl value (1st parameter) is not a string` before a
 * single test runs, and `AppInvitesBody` (which reuses `inviteDisclosureItems`) would
 * inherit the same import. Keeping every rule that decides WHICH control renders on this
 * side of the line means those rules stay directly testable, and stay reusable.
 *
 * Same View/container idiom as `AppsSubNavView`.
 */

/** One roster row, exactly as `appCollaborators.list` returns it. */
export type CollaboratorRosterRow = {
  userId: number;
  role: string;
  /** `pending | accepted | rejected`. Only `accepted` confers anything. */
  status: string;
  displayed: boolean;
  invitedBy: number;
};

export type AppCollaboratorsPanelViewProps = {
  /** The caller's role on this listing. `owner` unlocks invite + remove; nothing else does. */
  role: AppRole;
  /** The listing's KIND-derived capability row. Drives the earnings disclosure. */
  capabilities: Readonly<Record<ListingCapability, boolean>>;
  rows: CollaboratorRosterRow[];
  isLoading?: boolean;
  /** Set when `list` refused or failed — the roster is unknown, not empty. */
  errorMessage?: string | null;
  /** The signed-in user, so their OWN row can offer its self-service controls. */
  viewerUserId: number | null;
  /** The invite picker. Injected so the View carries no search-stack dependency. */
  userPicker?: ReactNode;
  onRemove?: (userId: number) => void;
  onSetDisplayed?: (displayed: boolean) => void;
  onLeave?: () => void;
  busy?: boolean;
  /** Identity renderer. Defaults to a plain id label so the View needs no data layer. */
  renderUser?: (userId: number) => ReactNode;
};

/**
 * 🔴 THE INVITE DISCLOSURE, and it is a REQUIREMENT rather than copy polish.
 *
 * An ACCEPTED editor can read the app's Buzz earnings (`appCollaborators.getAppEarnings`)
 * and, on an on-site app, holds Forgejo `write` on its repo. The owner has to be told
 * that BEFORE they send an invitation — discovering it afterwards means the disclosure
 * came too late to inform the decision it was about.
 *
 * 🔴 KIND-AWARE, from the capability row rather than from a second hardcoding: earnings
 * and the version/git surface are `false` for an off-site listing (no AppBlock ⇒ no
 * `BlockBuzzAttribution` row can exist, no bundle, no repo), so promising an off-site
 * invitee access to either would be a lie in the opposite direction.
 */
export function inviteDisclosureItems(
  capabilities: Readonly<Record<ListingCapability, boolean>>
): string[] {
  const items = ['Edit this app’s store listing — its details, media and screenshots.'];
  if (capabilities.submitForReview) items.push('Submit changes to moderators for review.');
  if (capabilities.analytics) items.push('See this app’s analytics.');
  if (capabilities.earnings) {
    items.push('See this app’s Buzz earnings and payout figures for the whole app.');
  }
  if (capabilities.submitVersion) {
    items.push('Push code and ship new versions of the app.');
  }
  return items;
}

/** `pending`/`rejected` are inert; say so rather than letting a badge imply access. */
function statusBadge(status: string) {
  if (status === 'accepted') return <Badge color="green">Collaborator</Badge>;
  if (status === 'pending') return <Badge color="yellow">Invite pending</Badge>;
  return <Badge color="gray">Declined</Badge>;
}

export function AppCollaboratorsPanelView({
  role,
  capabilities,
  rows,
  isLoading = false,
  errorMessage = null,
  viewerUserId,
  userPicker,
  onRemove,
  onSetDisplayed,
  onLeave,
  busy = false,
  renderUser,
}: AppCollaboratorsPanelViewProps) {
  const isOwner = role === 'owner';
  const identity = renderUser ?? ((userId: number) => <Text fw={500}>User #{userId}</Text>);
  const disclosure = useMemo(() => inviteDisclosureItems(capabilities), [capabilities]);
  // The viewer's OWN seat, if they hold one. Drives the two self-service controls.
  const ownRow = viewerUserId == null ? undefined : rows.find((r) => r.userId === viewerUserId);
  const ownAcceptedSeat = ownRow?.status === 'accepted' ? ownRow : undefined;

  return (
    <Stack gap="lg" data-testid="apps-collaborators-panel">
      {isOwner ? (
        <Stack gap="sm">
          <Title order={4}>Invite a collaborator</Title>
          {/* 🔴 The disclosure renders ABOVE the picker, so it cannot be missed by an
              owner who invites and navigates away. */}
          <Alert
            color="yellow"
            variant="light"
            icon={<IconCoin size={16} />}
            title="What a collaborator will be able to do"
            data-testid="apps-collaborators-invite-disclosure"
          >
            <Stack gap={4}>
              <List size="sm" spacing={2}>
                {disclosure.map((item) => (
                  <List.Item key={item}>{item}</List.Item>
                ))}
              </List>
              <Text size="sm">
                You stay the owner. Collaborators cannot invite or remove anyone, and cannot
                transfer the app.
              </Text>
            </Stack>
          </Alert>
          {userPicker}
          <Text size="xs" c="dimmed">
            Up to {constants.appCollaborators.maxCollaborators} collaborators per app. An invite
            does nothing until it is accepted.
          </Text>
        </Stack>
      ) : null}

      <Stack gap="sm">
        <Title order={4}>Collaborators</Title>
        {errorMessage ? (
          <Alert
            color="red"
            variant="light"
            icon={<IconAlertTriangle size={16} />}
            data-testid="apps-collaborators-error"
          >
            {errorMessage}
          </Alert>
        ) : isLoading ? (
          <Center py="md">
            <Loader size="sm" />
          </Center>
        ) : rows.length === 0 ? (
          <Text size="sm" c="dimmed" data-testid="apps-collaborators-empty">
            No collaborators yet.
          </Text>
        ) : (
          <Stack gap="xs">
            {rows.map((row) => (
              <Paper
                key={row.userId}
                withBorder
                p="sm"
                radius="md"
                data-testid={`apps-collaborator-row-${row.userId}`}
              >
                <Group justify="space-between" wrap="wrap" gap="sm">
                  <Group gap="sm">
                    {identity(row.userId)}
                    {statusBadge(row.status)}
                    {/* Public-byline STATE is shown to everyone who can read the roster;
                        only its owner may change it (see the switch below). */}
                    {row.status === 'accepted' && !row.displayed ? (
                      <Badge color="gray" variant="outline">
                        Hidden from the public byline
                      </Badge>
                    ) : null}
                  </Group>
                  <Group gap="xs">
                    {isOwner && onRemove ? (
                      <Button
                        size="xs"
                        variant="light"
                        color="red"
                        disabled={busy}
                        data-testid={`apps-collaborator-remove-${row.userId}`}
                        onClick={() => onRemove(row.userId)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </Group>
                </Group>
              </Paper>
            ))}
          </Stack>
        )}
      </Stack>

      {/* 🔴 SELF-SERVICE ONLY, and this is a deliberate divergence from "a per-seat toggle
          on the owner's roster". `appCollaborators.setDisplayed` writes
          `userId: ctx.user.id` — it can only ever change the CALLER's own row, and that is
          the correct model: `displayed` is a public-CREDIT preference belonging to the
          person named, not a capability the owner administers. An owner-driven toggle
          would let an app owner strip (or force) a collaborator's public credit, and
          would need a new proc to exist at all. The owner sees the state, read-only. */}
      {ownAcceptedSeat && onSetDisplayed ? (
        <Stack gap="xs">
          <Title order={5}>Your seat</Title>
          <Switch
            label="Show me on this app’s public page"
            description="Turn this off to keep your seat without appearing in the app’s public byline."
            checked={ownAcceptedSeat.displayed}
            disabled={busy}
            data-testid="apps-collaborator-displayed-toggle"
            onChange={(event) => onSetDisplayed(event.currentTarget.checked)}
          />
          {onLeave ? (
            <Group>
              <Button
                size="xs"
                variant="subtle"
                color="red"
                disabled={busy}
                data-testid="apps-collaborator-leave"
                onClick={onLeave}
              >
                Leave this app
              </Button>
            </Group>
          ) : null}
        </Stack>
      ) : null}

      {!isOwner ? (
        <Alert
          color="blue"
          variant="light"
          icon={<IconInfoCircle size={16} />}
          data-testid="apps-collaborators-editor-notice"
        >
          Only the app owner can invite or remove collaborators.
        </Alert>
      ) : null}
    </Stack>
  );
}
