import { Alert, Button, Code, Group, Modal, Radio, Stack, Text, Textarea } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import {
  visibilityCeilingReason,
  visibilityOptionsFor,
  visibilitySummaryLabel,
} from '~/components/Apps/listingVisibilityCopy';
import { OFFSITE_MOD_REASON_MIN } from '~/server/schema/blocks/offsite-moderation.schema';
import { isAppListingVisibility } from '~/shared/utils/app-listing-visibility';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * MOD: set a listing's VISIBILITY LEVEL, with the mandatory audited reason.
 *
 * 🔴 THE `reason` IS REQUIRED HERE AND OPTIONAL ON THE OWNER'S OWN CONTROL, and the
 * asymmetry is the point rather than an inconsistency. This is a moderator changing a
 * stranger's discoverability — the same class of act as delist/relist/claim, each of which
 * takes a `modReason` and lands a moderation event. The server enforces it
 * (`setListingVisibilityAsModeratorSchema`); this modal mirrors the floor so the moderator
 * is not told "too short" only after pressing Save.
 *
 * 🔴 IT SHARES THE OWNER MODAL'S COPY MODULE, NOT ITS COMPONENT. The level semantics are
 * identical for both audiences — same enum, same review ceiling, same "`private` means not
 * discoverable, NOT inaccessible" caveat — so `listingVisibilityCopy.ts` is the one
 * spelling, under the blocking unit project. What differs is the audience and the reason
 * field, which is what justifies a second component rather than a prop on the first.
 *
 * ⚠️ THE CURRENT LEVEL IS NOT SHOWN, because the moderation table's row DTO does not carry
 * it. That is a deliberate omission rather than an oversight: adding `visibility` to
 * `ModerationListingRow` means a per-row read of a manual-apply column on a paged mod
 * surface, and the batched reader exists for exactly that shape — so it is worth doing
 * properly (one statement for the page) rather than smuggled in as an N+1 here. Until
 * then the modal says so instead of implying the blank is "unset", which would be the
 * `null`-is-not-`private` confusion in a new place.
 */
export function ModListingVisibilityModal({
  target,
  onClose,
  onDone,
}: {
  target: { id: string; slug: string; status: string } | null;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [choice, setChoice] = useState<string>('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    setChoice('');
    setReason('');
  }, [target?.id]);

  const mutation = trpc.appListings.setListingVisibilityAsModerator.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Visibility updated.' });
      await onDone();
      onClose();
    },
    // The server stays authoritative: D1, the review ceiling and the manual-apply column
    // all refuse here, and the message is surfaced rather than swallowed.
    onError: (e) =>
      showErrorNotification({ title: 'Could not update visibility', error: new Error(e.message) }),
  });

  function close() {
    if (mutation.isPending) return;
    onClose();
  }

  if (!target) return null;

  const options = visibilityOptionsFor(target.status);
  const ceilingReason = visibilityCeilingReason(target.status);
  const reasonTooShort = reason.trim().length < OFFSITE_MOD_REASON_MIN;
  const chosenIsSettable =
    isAppListingVisibility(choice) && options.some((o) => o.value === choice && o.enabled);

  return (
    <Modal
      opened={!!target}
      onClose={close}
      title={
        <Text fw={600}>
          Set visibility for <Code>{target.slug}</Code>
        </Text>
      }
      centered
    >
      <Stack gap="md">
        <Alert
          color="blue"
          variant="light"
          icon={<IconInfoCircle size={16} />}
          data-testid="apps-mod-visibility-note"
        >
          <Text size="sm">
            This changes who can DISCOVER the listing in the store. It does not take the app offline
            and does not revoke access for anyone holding its link — use Hide for that.
          </Text>
        </Alert>

        {ceilingReason ? (
          <Text size="sm" c="dimmed" data-testid="apps-mod-visibility-ceiling">
            {ceilingReason}
          </Text>
        ) : null}

        <Radio.Group value={choice} onChange={setChoice} data-testid="apps-mod-visibility-options">
          <Stack gap="xs" mt="xs">
            {options.map((o) => (
              <Radio
                key={o.value}
                value={o.value}
                label={o.label}
                description={o.enabled ? o.description : `${o.description} — ${o.disabledReason}`}
                disabled={!o.enabled || mutation.isPending}
                data-testid={`apps-mod-visibility-option-${o.value}`}
              />
            ))}
          </Stack>
        </Radio.Group>

        <Text size="xs" c="dimmed">
          Current level is not shown here — see the listing&apos;s own Publishing tab. (Default for
          an unset listing: {visibilitySummaryLabel(null, target.status)}.)
        </Text>

        <Textarea
          label="Reason (required — recorded in the listing history the owner can read)"
          autosize
          minRows={2}
          maxRows={6}
          placeholder="Why this level is being set."
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          disabled={mutation.isPending}
          error={reason.length > 0 && reasonTooShort ? 'Too short' : undefined}
          data-testid="apps-mod-visibility-reason"
        />

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={close} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!isAppListingVisibility(choice)) return;
              mutation.mutate({
                appListingId: target.id,
                visibility: choice,
                reason: reason.trim(),
              });
            }}
            loading={mutation.isPending}
            disabled={!chosenIsSettable || reasonTooShort || mutation.isPending}
            data-testid="apps-mod-visibility-save"
          >
            Set visibility
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
