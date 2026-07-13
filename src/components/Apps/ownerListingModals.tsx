import { Alert, Badge, Button, Card, Code, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';
import { moderationActionChip } from '~/components/Apps/appListingModerationView';
import { OFFSITE_MOD_NOTE_MAX } from '~/server/schema/blocks/offsite-moderation.schema';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Shared OWNER-control modals for the App Store my-submissions surfaces (W13
 * post-approval mgmt). Factored out of the P3 `OffsiteSubmissionsList` so the P4
 * on-site `MySubmissionsList` reuses the EXACT same confirm-gated unpublish flow +
 * moderation-history timeline (no fork-copy). Both are DUAL-KIND: they hit the
 * widened `appListings.unpublishOwnListing` / `listMyListingModerationEvents` procs,
 * which handle on-site AND off-site listings server-side.
 *
 * The caller supplies:
 *   - `testIdPrefix` (`apps-offsite` | `apps-onsite`) so the two surfaces keep
 *     distinct, stable test hooks.
 *   - `onDone` — the query to invalidate on success (off-site:
 *     `appListings.listMySubmissions`; on-site: `blocks.listMyPublishRequests`).
 *   - `variant` — the takedown copy: `store` (off-site: "hidden from the store") vs
 *     `offline` (on-site: a FULL takedown — the app goes OFFLINE at `<slug>.civit.ai`
 *     / the run page, not just delisted from the store).
 */

export type OwnerModalTarget = { id: string; slug: string } | null;

/** Copy variant: `store` = off-site delist; `offline` = on-site full takedown. */
export type OwnerUnpublishVariant = 'store' | 'offline';

/**
 * Confirm-gated OWNER unpublish (approved → removed). Hides the listing from the
 * store immediately — no re-review needed, and the owner can republish it themselves.
 * On the on-site (`offline`) variant it ALSO takes the app OFFLINE (the backing block
 * is suspended server-side). `reason` is optional (the owner acts on their own listing).
 */
export function OwnerUnpublishModal({
  target,
  onClose,
  onDone,
  testIdPrefix,
  variant,
}: {
  target: OwnerModalTarget;
  onClose: () => void;
  onDone: () => Promise<void> | void;
  testIdPrefix: string;
  variant: OwnerUnpublishVariant;
}) {
  const [reason, setReason] = useState('');
  const mutation = trpc.appListings.unpublishOwnListing.useMutation({
    onSuccess: async () => {
      showSuccessNotification({
        message:
          variant === 'offline'
            ? 'App unpublished — it is now offline and hidden from the store.'
            : 'App unpublished — it is now hidden from the store.',
      });
      await onDone();
      setReason('');
      onClose();
    },
    onError: (e) => showErrorNotification({ title: 'Unpublish failed', error: new Error(e.message) }),
  });

  function close() {
    if (mutation.isPending) return;
    setReason('');
    onClose();
  }

  if (!target) return null;
  return (
    <Modal
      opened={!!target}
      onClose={close}
      title={
        <Text fw={600}>
          Unpublish <Code>{target.slug}</Code>
        </Text>
      }
      centered
    >
      <Stack gap="md">
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
          <Text size="sm">
            {variant === 'offline'
              ? 'Unpublishing takes your app OFFLINE immediately — it stops serving at its ' +
                'app page and is removed from the store. This is a full takedown, not just a ' +
                'delist. You can republish it yourself at any time — no re-review needed.'
              : 'Unpublishing hides your live app from the store immediately. You can republish ' +
                'it yourself at any time — no re-review needed.'}
          </Text>
        </Alert>
        <Textarea
          label="Reason (optional)"
          autosize
          minRows={2}
          maxRows={6}
          maxLength={OFFSITE_MOD_NOTE_MAX}
          placeholder="Optional — a note for your own records / the listing history."
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          disabled={mutation.isPending}
          data-testid={`${testIdPrefix}-unpublish-reason`}
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={close} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            color="orange"
            onClick={() =>
              mutation.mutate({
                appListingId: target.id,
                reason: reason.trim() ? reason.trim() : undefined,
              })
            }
            loading={mutation.isPending}
            disabled={mutation.isPending}
            data-testid={`${testIdPrefix}-unpublish-confirm`}
          >
            Unpublish
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * OWNER moderation-history modal — the "why was this hidden / un-approved" view.
 * Renders the listing's `AppListingModerationEvent` timeline (newest-first) via the
 * owner-scoped, PII-minimal `listMyListingModerationEvents` proc: each entry's action
 * + date + (verbatim) reason. Owner-scoped server-side (own listing only).
 */
export function OwnerModerationHistoryModal({
  target,
  onClose,
  testIdPrefix,
}: {
  target: OwnerModalTarget;
  onClose: () => void;
  testIdPrefix: string;
}) {
  const query = trpc.appListings.listMyListingModerationEvents.useQuery(
    { appListingId: target?.id ?? '', limit: 50 },
    { enabled: !!target }
  );
  const items = (query.data?.items ?? []) as Array<{
    id: string;
    action: string;
    reason: string | null;
    createdAt: string | Date;
  }>;

  return (
    <Modal
      opened={!!target}
      onClose={onClose}
      title={
        <Text fw={600}>
          Moderation history{target ? <> — <Code>{target.slug}</Code></> : null}
        </Text>
      }
      size="lg"
      centered
    >
      {query.isLoading ? (
        <Text size="sm" c="dimmed">
          Loading…
        </Text>
      ) : query.error ? (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
          {query.error.message}
        </Alert>
      ) : items.length === 0 ? (
        <Text size="sm" c="dimmed" data-testid={`${testIdPrefix}-history-empty`}>
          No moderation history yet.
        </Text>
      ) : (
        <Stack gap="sm" data-testid={`${testIdPrefix}-history-list`}>
          {items.map((ev) => {
            const chip = moderationActionChip(ev.action);
            return (
              <Card key={ev.id} withBorder p="sm" data-testid={`${testIdPrefix}-history-entry`}>
                <Group justify="space-between" gap="xs" wrap="nowrap">
                  <Badge color={chip.color} variant="light">
                    {chip.label}
                  </Badge>
                  <Text size="xs" c="dimmed">
                    {formatDate(ev.createdAt)}
                  </Text>
                </Group>
                {ev.reason && (
                  <Text size="sm" mt={6} style={{ whiteSpace: 'pre-wrap' }}>
                    {ev.reason}
                  </Text>
                )}
              </Card>
            );
          })}
        </Stack>
      )}
    </Modal>
  );
}
