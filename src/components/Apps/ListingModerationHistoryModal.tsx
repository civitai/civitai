import { Badge, Button, Card, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconHistory } from '@tabler/icons-react';

import {
  moderationActionChip,
  type ModerationHistoryTarget,
  retryableOfflineCutEventId,
} from '~/components/Apps/appListingModerationView';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  showErrorNotification,
  showSuccessNotification,
  showWarningNotification,
} from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString();
}

type ModEvent = {
  id: string;
  appListingId: string | null;
  slug: string;
  action: string;
  reason: string | null;
  detail: string | null;
  before: unknown;
  after: unknown;
  reportId: string | null;
  createdAt: string | Date;
  actor: { id: number; username: string | null; image: string | null } | null;
};

/**
 * The ownership transfer carried by a `claim` event's `{userId}`-shaped before/after.
 * Returns null for any non-claim event (delist/relist/purge/report-* carry a
 * `{status}`-shaped before/after instead), so the history row only renders the
 * transfer for claims — it never mis-reads a status event's payload. before/after are
 * typed `unknown` (JSON columns), so each userId is narrowed to a number defensively.
 */
function claimOwnerTransfer(e: ModEvent): { from: number | null; to: number | null } | null {
  if (e.action !== 'claim') return null;
  const before = (e.before ?? null) as { userId?: unknown } | null;
  const after = (e.after ?? null) as { userId?: unknown } | null;
  const from = typeof before?.userId === 'number' ? before.userId : null;
  const to = typeof after?.userId === 'number' ? after.userId : null;
  if (from === null && to === null) return null;
  return { from, to };
}

/**
 * MOD per-listing moderation history (newest-first audit trail), with "Retry cut" on the newest
 * `offline-cut-failed` row. ONE component for every moderator surface: the reports queue, the
 * /apps/review management table and the takedown warning toast (from whichever surface the
 * takedown started) all open it through {@link openListingModerationHistory}. It reads `listModerationEvents`, which
 * is `moderatorProcedure`, so a non-moderator who somehow mounted it would read nothing.
 */
export function ListingModerationHistoryModal({
  listing,
  onClose,
}: {
  listing: ModerationHistoryTarget | null;
  onClose: () => void;
}) {
  const features = useFeatureFlags();
  const utils = trpc.useUtils();
  const query = trpc.appListings.listModerationEvents.useQuery(
    { appListingId: listing?.appListingId ?? '', limit: 50 },
    { enabled: !!features?.appBlocks && !!listing?.appListingId, retry: false }
  );
  // "Retry cut" on the newest `offline-cut-failed` row. The server re-checks the flag, that the
  // listing is still taken down and that no other listing declares offline access; either outcome
  // is recorded as a new history row, so the list is refetched.
  const retryCut = trpc.appListings.retryConnectOfflineCut.useMutation({
    onSuccess: async (result) => {
      if (result.outcome === 'cut') {
        showSuccessNotification({
          message: `Offline access cut (${result.deleted} refresh token${
            result.deleted === 1 ? '' : 's'
          } deleted).`,
        });
      } else {
        showWarningNotification({
          title: 'Offline access not cut',
          message: 'The retry failed too. The failure is recorded in the history.',
        });
      }
      await utils.appListings.listModerationEvents.invalidate();
    },
    onError: (e) => showErrorNotification({ title: 'Retry failed', error: new Error(e.message) }),
  });

  if (!listing) return null;
  const events = (query.data?.items ?? []) as ModEvent[];
  const retryableId = retryableOfflineCutEventId(events);

  return (
    <Modal
      opened={!!listing}
      onClose={onClose}
      title={
        <Group gap={6}>
          <IconHistory size={16} />
          <Text fw={600}>Moderation history — {listing.slug || listing.appListingId}</Text>
        </Group>
      }
      size="lg"
      centered
    >
      {query.isLoading ? (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Loading…
          </Text>
        </Group>
      ) : events.length === 0 ? (
        <Text size="sm" c="dimmed">
          No moderation events recorded for this listing yet.
        </Text>
      ) : (
        <Stack gap="xs">
          {events.map((e) => {
            const chip = moderationActionChip(e.action);
            const transfer = claimOwnerTransfer(e);
            return (
              <Card key={e.id} withBorder p="sm">
                <Group justify="space-between" gap="xs">
                  <Group gap={6}>
                    <Badge size="sm" color={chip.color} variant="light">
                      {chip.label}
                    </Badge>
                    <Text size="xs" c="dimmed">
                      by {e.actor?.username ?? `#${e.actor?.id ?? '?'}`}
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {formatDate(e.createdAt)}
                  </Text>
                </Group>
                {transfer && (
                  <Text size="xs" c="dimmed" mt={4} data-testid={`apps-mod-event-owner-${e.id}`}>
                    owner: {transfer.from ?? '?'} → {transfer.to ?? '?'}
                  </Text>
                )}
                {e.reason && (
                  <Text size="sm" mt={4} style={{ whiteSpace: 'pre-wrap' }}>
                    {e.reason}
                  </Text>
                )}
                {e.action === 'offline-cut-failed' && e.detail && (
                  <Text size="xs" c="dimmed" mt={4} style={{ whiteSpace: 'pre-wrap' }}>
                    {e.detail}
                  </Text>
                )}
                {e.id === retryableId && e.appListingId && (
                  <Group justify="flex-end" mt={4}>
                    <Button
                      size="xs"
                      variant="light"
                      color="orange"
                      loading={retryCut.isPending}
                      onClick={() =>
                        e.appListingId && retryCut.mutate({ appListingId: e.appListingId })
                      }
                      data-testid={`apps-mod-event-retry-cut-${e.id}`}
                    >
                      Retry cut
                    </Button>
                  </Group>
                )}
              </Card>
            );
          })}
        </Stack>
      )}
    </Modal>
  );
}

/** The dialog id for a listing's history, so opening it twice shows one modal. */
export function listingModerationHistoryDialogId(appListingId: string): string {
  return `listing-moderation-history-${appListingId}`;
}

/**
 * Open a listing's moderation history from ANY moderator surface. It goes through the global
 * dialog store rather than surface-local state on purpose: a takedown from the store detail page
 * blanks that page (the listing is no longer approved), which would unmount a locally owned modal
 * and leave the toast's "open history" with nothing to open.
 */
export function openListingModerationHistory(listing: ModerationHistoryTarget): void {
  const id = listingModerationHistoryDialogId(listing.appListingId);
  dialogStore.trigger({
    id,
    component: ListingModerationHistoryModal,
    props: { listing, onClose: () => dialogStore.closeById(id) },
  });
}
