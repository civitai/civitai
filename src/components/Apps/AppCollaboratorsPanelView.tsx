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
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconCoin, IconInfoCircle } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { constants } from '~/server/common/constants';
import type { AppRole, ListingCapability } from '~/shared/constants/app-capabilities.constants';
import {
  CONNECT_CLIENT_TRANSFER_REFUSAL,
  refusesTransferForConnectClient,
} from '~/shared/constants/app-transfer.constants';

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

  // ---------------------------------------------------------------------------
  // OWNERSHIP TRANSFER — owner-only. See {@link OwnerTransferSection}.
  // ---------------------------------------------------------------------------
  /** The live outgoing offer on this listing, or null. */
  pendingTransfer?: PendingTransferRow | null;
  /**
   * 🔴 The REASON the last transfer attempt was refused, rendered inline.
   *
   * A connect-linked off-site listing is refused with a specific, actionable message
   * ("unlink the OAuth client first"). Collapsing that into a generic "something went
   * wrong" toast would leave the owner with an action that fails forever and no way to
   * learn why, so the message is surfaced where the control is.
   */
  transferErrorMessage?: string | null;
  /** The recipient picker. Injected, like `userPicker`, to keep the search stack out. */
  transferPicker?: ReactNode;
  onCancelTransfer?: (transferId: string) => void;
  transferBusy?: boolean;
  /**
   * 🔴 THE LISTING ITSELF, so the transfer verdict can be reached BEFORE the owner acts.
   *
   * `transferErrorMessage` above is a mutation RESULT — it can only ever arrive after the
   * owner has picked a recipient and submitted. A connect-linked off-site listing is
   * refused every single time, so that path made the refusal something the owner could
   * only discover by doing the work. This prop is the same fact BEFORE the click, and the
   * verdict is {@link refusesTransferForConnectClient} — the SAME function the service
   * gates on, imported from `shared/` so the two cannot drift.
   *
   * Optional so the roster half of this View stays renderable without it; when it is
   * absent nothing is refused, which is the pre-existing behaviour exactly.
   */
  listing?: TransferListingFacts | null;
};

/**
 * The listing facts the transfer verdict is computed from. Structurally the argument of
 * {@link refusesTransferForConnectClient} — deliberately, so widening the rule cannot
 * leave this surface behind.
 */
export type TransferListingFacts = {
  kind: string;
  /** The linked OAuth `client_id`, or `null`. Public, not a secret. */
  connectClientId: string | null;
};

/** The live outgoing offer, as `appCollaborators.getPendingTransfer` returns it. */
export type PendingTransferRow = {
  id: string;
  toUserId: number;
  expiresAt: Date | string;
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

/**
 * 🔴 OWNERSHIP TRANSFER — THE OWNER HALF, and it renders for the OWNER ONLY.
 *
 * `initiateTransfer` and `cancelTransfer` are owner-gated in the service
 * (`loadOwnedListing` → NOT_OWNER; `cancelTransfer` → "you are not party to this
 * transfer"), and the collaborator disclosure two sections up promises in so many words
 * that "collaborators cannot invite or remove anyone, and cannot transfer the app".
 * Rendering the control for an editor would both contradict that promise and offer a
 * button that is guaranteed to 403.
 *
 * Extracted as its own component so the owner/editor split is ONE condition at ONE call
 * site rather than a `isOwner &&` repeated across five controls.
 */
function OwnerTransferSection({
  pendingTransfer,
  transferErrorMessage,
  transferPicker,
  onCancelTransfer,
  transferBusy,
  renderUser,
  listing,
}: {
  pendingTransfer: PendingTransferRow | null;
  transferErrorMessage: string | null;
  transferPicker?: ReactNode;
  onCancelTransfer?: (transferId: string) => void;
  transferBusy: boolean;
  renderUser: (userId: number) => ReactNode;
  listing: TransferListingFacts | null;
}) {
  /**
   * 🔴 THE UP-FRONT VERDICT, and it is the ONLY call of the rule on this surface. The
   * service asks the same function at initiate and again in-transaction at accept; asking
   * it here too is what stops the tab from offering an action the server will refuse. It
   * is NOT a replacement for either server gate — those are unchanged and authoritative,
   * and this one runs on data the client can lie to itself about.
   */
  const refusedForConnectClient = listing ? refusesTransferForConnectClient(listing) : false;
  return (
    <Stack gap="sm" data-testid="apps-transfer-owner-section">
      <Title order={4}>Transfer ownership</Title>
      <Alert
        color="red"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        title="Transferring hands the whole app to someone else"
        data-testid="apps-transfer-owner-disclosure"
      >
        <Stack gap={4}>
          <Text size="sm">
            Once they accept, you are no longer the owner: you lose editing, submitting and every
            other owner control. Buzz you have already earned stays with you.
          </Text>
          <Text size="sm">Nothing moves until the person you choose accepts.</Text>
        </Stack>
      </Alert>

      {/* 🔴 THE REFUSAL, UP FRONT — before a recipient is chosen, not after.
          Rendered from the LISTING, so it is on screen the moment the tab opens. The
          message is the server's own constant, not a paraphrase: the owner reads the same
          sentence here that the mutation would have returned, including its remedy. */}
      {refusedForConnectClient ? (
        <Alert
          color="yellow"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          title="Ownership cannot be transferred for this app"
          data-testid="apps-transfer-blocked"
        >
          {CONNECT_CLIENT_TRANSFER_REFUSAL}
        </Alert>
      ) : null}

      {/* 🔴 THE REFUSAL, WITH ITS REASON. See `transferErrorMessage`. */}
      {transferErrorMessage ? (
        <Alert
          color="red"
          variant="filled"
          icon={<IconAlertTriangle size={16} />}
          title="Ownership cannot be transferred"
          data-testid="apps-transfer-owner-error"
        >
          {transferErrorMessage}
        </Alert>
      ) : null}

      {pendingTransfer ? (
        <Paper withBorder p="sm" radius="md" data-testid="apps-transfer-pending">
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Group gap="xs">
              <Badge color="orange">Transfer pending</Badge>
              <Text size="sm">Offered to</Text>
              {renderUser(pendingTransfer.toUserId)}
            </Group>
            {onCancelTransfer ? (
              <Button
                size="xs"
                variant="light"
                color="red"
                disabled={transferBusy}
                data-testid="apps-transfer-cancel"
                onClick={() => onCancelTransfer(pendingTransfer.id)}
              >
                Cancel transfer
              </Button>
            ) : null}
          </Group>
        </Paper>
      ) : (
        /* 🔴 The picker and the pending card are MUTUALLY EXCLUSIVE. One live offer per
           listing is a partial-unique index in the database, so a second initiate would
           lose on P2002 — offering the control while an offer is open would render an
           action that cannot succeed. */
        <Stack gap="xs">
          {/* 🔴 DISABLED, NOT HIDDEN. Removing the section entirely would leave the owner
              asking why their app has no transfer control at all — a different confusion,
              not a smaller one. The control stays where they expect it, visibly off, with
              the reason directly above it and a remedy they can act on. The real picker is
              not merely disabled but UNMOUNTED, so no path through it can fire the
              mutation; this stand-in occupies its place and states the same purpose. */}
          {refusedForConnectClient ? (
            <TextInput
              disabled
              readOnly
              value=""
              aria-label="Search for the person who should own this app"
              placeholder="Search for the person who should own this app"
              data-testid="apps-transfer-picker-disabled"
            />
          ) : (
            transferPicker
          )}
          <Text size="xs" c="dimmed">
            One transfer offer at a time. It expires after{' '}
            {constants.appCollaborators.transferExpiryDays} days if it is not accepted.
          </Text>
        </Stack>
      )}
    </Stack>
  );
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
  pendingTransfer = null,
  transferErrorMessage = null,
  transferPicker,
  onCancelTransfer,
  transferBusy = false,
  listing = null,
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

      {isOwner ? (
        <OwnerTransferSection
          pendingTransfer={pendingTransfer}
          transferErrorMessage={transferErrorMessage}
          transferPicker={transferPicker}
          onCancelTransfer={onCancelTransfer}
          transferBusy={transferBusy}
          renderUser={identity}
          listing={listing}
        />
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
