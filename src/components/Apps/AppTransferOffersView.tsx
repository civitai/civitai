import { Alert, Badge, Button, Group, List, Paper, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconArrowsExchange } from '@tabler/icons-react';
import type { ReactNode } from 'react';

import type { IncomingTransferView } from '~/server/services/blocks/app-ownership-transfer.service';
import type { ListingKind } from '~/shared/constants/app-capabilities.constants';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';

/**
 * `/apps/invites` — the OWNERSHIP-OFFER half of the inbox.
 *
 * 🔴 A SEPARATE COMPONENT, RENDERED ABOVE THE SEAT INVITES, because the two are not the
 * same size of decision and must not read as the same row in a list. A seat invite adds
 * an editor; an ownership transfer moves the app OUT of one account and INTO another,
 * and the person who currently owns it loses every capability on it the instant the
 * offer is accepted. Presenting both as generic "invitation" cards would make the
 * irreversible one a one-click sibling of the reversible one.
 *
 * The distinction is carried by three things a test can assert, not by tone:
 *   - its own heading and section testid (`apps-transfers-section`);
 *   - a RED warning panel naming what accepting does (`apps-transfer-warning-<id>`);
 *   - a button that says "Accept ownership", not "Accept".
 *
 * 🔴 PROPS-ONLY, no tRPC — same split as `AppCollaboratorsPanelView`, so every branch is
 * directly renderable in a component test.
 */

/**
 * 🔴 DERIVED FROM THE SERVICE'S OWN RETURN TYPE, not hand-written beside it.
 *
 * This used to be a structural duplicate of {@link IncomingTransferView}, and the
 * container's `as IncomingTransferRow[]` cast made the duplication INVISIBLE to `tsc`: a
 * cast to a wider type is legal, so a field the service stopped sending — or never started
 * sending — compiled clean at exactly the hop where the defect lives. #3935 hit the same
 * hole on `edit.tsx` and fixed it the same way; the container's cast is now GONE as well,
 * so the tRPC output type is checked against this one directly.
 *
 * The two date fields are deliberately WIDENED rather than inherited. The service types
 * them `Date`; what actually arrives depends on the tRPC transformer, and a component that
 * hard-required `Date` would be making a claim about the wire that this file cannot settle.
 * {@link formatTransferExpiry} accepts either, so the widening costs nothing and the other
 * fields — including `acceptBlockedReason`, the point of this change — stay pinned to the
 * server's shape.
 *
 * A type-only import is erased at build time, so nothing of the service's module graph
 * reaches the client bundle.
 */
export type IncomingTransferRow = Omit<IncomingTransferView, 'expiresAt' | 'createdAt'> & {
  expiresAt: Date | string;
  createdAt: Date | string;
};

export type AppTransferOffersViewProps = {
  transfers: IncomingTransferRow[];
  isLoading?: boolean;
  /** Set when the read failed. An empty inbox and an unknown inbox are NOT the same. */
  errorMessage?: string | null;
  /** The transfer id currently in flight, if any. */
  busyTransferId?: string | null;
  onRespond?: (transferId: string, accept: boolean) => void;
  /** Renders the offering user. Injected so this View keeps no data-layer dependency. */
  renderOfferer?: (userId: number) => ReactNode;
};

/**
 * What accepting an ownership offer actually does, kind-aware.
 *
 * 🔴 DERIVED FROM THE SAME CAPABILITY ROW the collaborator disclosure uses, so the two
 * cannot drift into promising an off-site recipient a repo or an earnings page that
 * cannot exist for a listing with no AppBlock.
 */
export function transferDisclosureItems(kind: ListingKind): string[] {
  const capabilities = capabilitiesForKind(kind);
  const items = [
    'You become the owner of this app’s store listing.',
    'The current owner loses ownership, including the ability to edit, submit or transfer it.',
  ];
  if (capabilities.submitVersion) {
    items.push('You take over the app’s code repository and can ship new versions.');
  }
  if (capabilities.earnings) {
    items.push(
      'Buzz earned BEFORE the transfer stays with the previous owner — you start from zero.'
    );
  }
  items.push('Existing collaborators keep their seats.');
  return items;
}

/** Human date for the offer deadline. Fixed locale so a test can pin the string. */
export function formatTransferExpiry(expiresAt: Date | string): string {
  const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return 'soon';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function AppTransferOffersView({
  transfers,
  isLoading = false,
  errorMessage = null,
  busyTransferId = null,
  onRespond,
  renderOfferer,
}: AppTransferOffersViewProps) {
  const offerer =
    renderOfferer ??
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
        data-testid="apps-transfers-error"
      >
        {errorMessage}
      </Alert>
    );
  }
  // 🔴 NOTHING is rendered while loading, and NOTHING is rendered when there are no
  // offers. Deliberately unlike the seat inbox, which shows "you have no pending
  // invitations": an empty-state for a surface that is empty for virtually every user,
  // sitting above the surface they actually came for, is noise. The absence of the
  // section IS the empty state.
  if (isLoading || transfers.length === 0) return null;

  return (
    <Stack gap="md" data-testid="apps-transfers-section">
      <Title order={4}>Ownership transfers</Title>
      {transfers.map((transfer) => {
        const busy = busyTransferId === transfer.transferId;
        /**
         * 🔴 THE VERDICT ARRIVES ON THE PAYLOAD, ALREADY DECIDED. No predicate is
         * re-run here and no `connectClientId` is in scope — the service computed this
         * from the SAME `refusesTransferForConnectClient` its two enforcement gates use,
         * so this surface cannot invent a stricter or looser rule of its own.
         */
        const blockedReason = transfer.acceptBlockedReason;
        return (
          <Paper
            key={transfer.transferId}
            withBorder
            p="md"
            radius="md"
            data-testid={`apps-transfer-${transfer.transferId}`}
          >
            <Stack gap="sm">
              <Group justify="space-between" wrap="wrap" gap="xs">
                <Group gap="xs">
                  <Text fw={600}>{transfer.name || transfer.slug}</Text>
                  <Badge
                    color="red"
                    variant="filled"
                    leftSection={<IconArrowsExchange size={12} />}
                    data-testid={`apps-transfer-badge-${transfer.transferId}`}
                  >
                    Ownership transfer
                  </Badge>
                  <Badge variant="light" color={transfer.kind === 'onsite' ? 'blue' : 'grape'}>
                    {transfer.kind === 'onsite' ? 'On-site app' : 'External app'}
                  </Badge>
                </Group>
                <Group
                  gap={4}
                  wrap="nowrap"
                  data-testid={`apps-transfer-offerer-${transfer.transferId}`}
                >
                  <Text size="xs" c="dimmed">
                    Offered by
                  </Text>
                  {offerer(transfer.fromUserId)}
                </Group>
              </Group>

              {/* 🔴 THE REFUSAL, BEFORE THE CLICK — the recipient half of #3935.
                  `acceptTransfer` re-asserts the connect-client refusal IN-TRANSACTION
                  precisely because a revision approve can link an OAuth client while an
                  offer sits open, so this card can be live, valid and guaranteed to fail.
                  Without this the recipient learned that only by pressing Accept and
                  reading a toast — the same learn-it-by-doing-the-work shape the owner's
                  tab already fixed, on the other side of the wire.

                  The message is the SERVER's own constant, verbatim, not a paraphrase: the
                  recipient reads the same sentence the mutation would have returned. It
                  states a constraint and instructs NOTHING, because there is no unlink
                  path in the product for them OR the owner to pursue. */}
              {blockedReason ? (
                <Alert
                  color="yellow"
                  variant="light"
                  icon={<IconAlertTriangle size={16} />}
                  title="This offer can no longer be accepted"
                  data-testid={`apps-transfer-blocked-${transfer.transferId}`}
                >
                  {blockedReason}
                </Alert>
              ) : null}

              {/* 🔴 RED, not the seat invite's yellow, and it names the consequences
                  BEFORE the button rather than after the click.

                  🔴 RETAINED ON A BLOCKED CARD, DELIBERATELY, and this diverges from the
                  owner-side treatment in #3935 (which suppressed its equivalent copy).
                  Two reasons. It is a load-bearing IDENTITY marker: the pair test in
                  `AppTransferOffersView.browser.test.tsx` names this panel as one of three
                  things stopping an irreversible ownership transfer from reading like a
                  reversible seat invite, and dropping it on some cards makes that property
                  conditional. And unlike the owner's suppressed copy — which described
                  MECHANICS of a transfer that can never start — this describes what the
                  offer WAS FOR, which is exactly what the recipient still needs in order
                  to decide to decline it. */}
              <Alert
                color="red"
                variant="light"
                icon={<IconAlertTriangle size={16} />}
                title="Accepting this transfers the whole app to you"
                data-testid={`apps-transfer-warning-${transfer.transferId}`}
              >
                <List size="sm" spacing={2}>
                  {transferDisclosureItems(transfer.kind).map((item) => (
                    <List.Item key={item}>{item}</List.Item>
                  ))}
                </List>
              </Alert>

              <Text
                size="xs"
                c="dimmed"
                data-testid={`apps-transfer-expiry-${transfer.transferId}`}
              >
                This offer expires on {formatTransferExpiry(transfer.expiresAt)}.
              </Text>

              <Group gap="xs">
                {/* 🔴 ACCEPT IS DISABLED, DECLINE IS NOT, and the asymmetry is the point.
                    `acceptTransfer` refuses this offer every time; `cancelTransfer` — which
                    is how a recipient DECLINES — carries no connect-client gate at all and
                    admits either party. So getting out of a dead offer is exactly the
                    action that must still work, and disabling both would strand the
                    recipient with a card they can neither accept nor clear.

                    DISABLED, NOT HIDDEN, for the same reason the owner's control is: a
                    vanished button leaves them wondering whether the offer is real. */}
                <Button
                  size="xs"
                  color="red"
                  disabled={busy || blockedReason != null}
                  loading={busy}
                  data-testid={`apps-transfer-accept-${transfer.transferId}`}
                  onClick={() => onRespond?.(transfer.transferId, true)}
                >
                  Accept ownership
                </Button>
                <Button
                  size="xs"
                  variant="light"
                  disabled={busy}
                  data-testid={`apps-transfer-decline-${transfer.transferId}`}
                  onClick={() => onRespond?.(transfer.transferId, false)}
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
 * What a settled transfer response must invalidate. PURE and exported for the same
 * reason `invalidationsForInviteResponse` is: the bug lives in the mutation callback, and
 * a callback is not testable without a tRPC client.
 *
 * 🔴 IDENTICAL ON BOTH VERDICTS, and `accept` stays a parameter so a test can pin the two
 * as EQUAL rather than pin one and assume the other. `appListings.listMine` matters on
 * ACCEPT (a whole app arrives); the inbox and the nav counts matter on BOTH, because
 * DECLINING is the case that can take the offer count to zero.
 */
export type TransferInvalidationKey =
  | 'appCollaborators.listMyPendingTransfers'
  | 'appListings.listMine'
  | 'blocks.getNavSummary';

export function invalidationsForTransferResponse(accept: boolean): TransferInvalidationKey[] {
  void accept;
  return [
    'appCollaborators.listMyPendingTransfers',
    'appListings.listMine',
    'blocks.getNavSummary',
  ];
}
