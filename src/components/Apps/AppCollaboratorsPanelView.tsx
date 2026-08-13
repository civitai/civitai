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
  /**
   * Set a seat's public-byline flag.
   *
   * 🔴 `targetUserId` is OMITTED on the SELF path and PRESENT on the owner path, and that
   * absence is load-bearing rather than an ergonomic: the proc selects its self-service
   * branch on exactly that, so always sending the viewer's id would route a plain
   * collaborator through the OWNER gate and 403 them off their own byline.
   */
  onSetDisplayed?: (displayed: boolean, targetUserId?: number) => void;
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

/**
 * Why an invite for `userId` cannot be sent, or `null` when it can. PURE.
 *
 * 🔴 A `rejected` SEAT IS RE-INVITABLE. `inviteCollaborator` documents and implements
 * re-opening a declined invite — "declining is not permanent, and the invitee must consent
 * again" — but the picker excluded EVERY roster row, so a user who declined once could
 * never be asked again. The service path existed and the UI made it unreachable.
 *
 * 🔴 It returns a REASON rather than a boolean because the caller must be able to SAY
 * something: the original guard was a silent `return`, which makes a legitimate click look
 * like a broken picker.
 */
export function inviteBlockedReason(
  rows: CollaboratorRosterRow[],
  userId: number
): { title: string; message: string } | null {
  const row = rows.find((r) => r.userId === userId);
  if (!row || row.status === 'rejected') return null;
  return row.status === 'accepted'
    ? { title: 'Already on this app', message: 'That user is already a collaborator.' }
    : { title: 'Already invited', message: 'That user already has a pending invitation.' };
}

/** The roster ids the picker hides. A REJECTED seat stays offerable — see above. */
export function pickerExcludedUserIds(rows: CollaboratorRosterRow[]): number[] {
  return rows.filter((r) => r.status !== 'rejected').map((r) => r.userId);
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
                    {/* Public-byline STATE, read-only. Shown to anyone who can read the
                        roster but has no control over this row — an OWNER gets the switch
                        instead (below), so the two never render together and the state is
                        stated exactly once. */}
                    {row.status === 'accepted' && !row.displayed && !isOwner ? (
                      <Badge color="gray" variant="outline">
                        Hidden from the public byline
                      </Badge>
                    ) : null}
                  </Group>
                  <Group gap="xs">
                    {/* 🔴 OWNER CONTROL OVER SOMEONE ELSE'S BYLINE — a deliberate product
                        decision (see the describe block in the browser test and the
                        service header). ACCEPTED rows only: nobody, owner included, may
                        pre-arrange public credit for an invitation not yet taken, and the
                        service's `status: ACCEPTED` guard would refuse it anyway — so
                        rendering it on a pending row would be an action that 403s. */}
                    {isOwner && onSetDisplayed && row.status === 'accepted' ? (
                      <Switch
                        size="xs"
                        labelPosition="left"
                        label="Public byline"
                        checked={row.displayed}
                        disabled={busy}
                        data-testid={`apps-collaborator-row-displayed-${row.userId}`}
                        onChange={(event) =>
                          onSetDisplayed(event.currentTarget.checked, row.userId)
                        }
                      />
                    ) : null}
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

      {/* 🔴 THE SELF-SERVICE HALF, which the owner control ADDS TO rather than replaces:
          every accepted collaborator always controls their own byline, whoever else can
          also reach it. It calls `onSetDisplayed` with NO target id — that absence is what
          selects the proc's self path, so a collaborator who is not the owner is never
          routed through the owner gate on their own row. Last writer wins between the two
          controls; see the service header for why there is deliberately no precedence
          rule. */}
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
