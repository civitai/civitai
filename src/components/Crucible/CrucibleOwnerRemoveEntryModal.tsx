import { Button, Group, Select, Stack, Text, Textarea } from '@mantine/core';
import { closeAllModals, openModal } from '@mantine/modals';
import { useState } from 'react';
import {
  CRUCIBLE_OWNER_REMOVAL_CAP,
  CRUCIBLE_OWNER_REMOVAL_NOTE_MAX_LENGTH,
  crucibleOwnerRemovalReasons,
  type CrucibleOwnerRemovalReason,
} from '~/utils/crucible-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const reasonOptions = Object.entries(crucibleOwnerRemovalReasons).map(([value, label]) => ({
  value,
  label,
}));

function OwnerRemoveEntryForm({
  crucibleId,
  entryId,
  entrantName,
  entryFee,
  removalsLeft,
}: {
  crucibleId: number;
  entryId: number;
  entrantName?: string | null;
  entryFee: number;
  removalsLeft: number;
}) {
  const utils = trpc.useUtils();
  const [reason, setReason] = useState<CrucibleOwnerRemovalReason | null>(null);
  const [note, setNote] = useState('');

  const removeEntry = trpc.crucible.ownerRemoveEntry.useMutation({
    onSuccess: (result) => {
      showSuccessNotification({
        title: 'Entry removed',
        message: result.refundedAmount
          ? `${result.refundedAmount.toLocaleString()} Buzz refunded to the entrant.`
          : 'It was a free entry, so there was nothing to refund.',
      });
      closeAllModals();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not remove entry', error: new Error(error.message) }),
    // The count moves even when the removal fails on the cap, so refresh either way.
    onSettled: () => {
      utils.crucible.getById.invalidate({ id: crucibleId });
      utils.crucible.getEntries.invalidate({ crucibleId });
    },
  });

  const noteRequired = reason === 'other';
  const canSubmit = removalsLeft > 0 && !!reason && (!noteRequired || !!note.trim());

  return (
    <Stack gap="sm">
      <Text size="sm">
        Remove {entrantName ? `${entrantName}'s` : 'this'} entry?{' '}
        {entryFee > 0
          ? 'Their entry fee is refunded.'
          : 'It was a free entry, so there is nothing to refund.'}{' '}
        They are told you removed it, and why. This can&apos;t be undone.
      </Text>
      <Select
        label="Reason"
        placeholder="Why are you removing it?"
        data={reasonOptions}
        value={reason}
        onChange={(value) => setReason(value as CrucibleOwnerRemovalReason | null)}
        allowDeselect={false}
        comboboxProps={{ withinPortal: true, zIndex: 500 }}
        disabled={removalsLeft === 0}
        withAsterisk
      />
      {noteRequired && (
        <Textarea
          label="Tell them why"
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
          maxLength={CRUCIBLE_OWNER_REMOVAL_NOTE_MAX_LENGTH}
          autosize
          minRows={2}
          withAsterisk
        />
      )}
      <Text size="sm" c={removalsLeft === 0 ? 'red' : 'dimmed'}>
        {removalsLeft === 0
          ? `You've used all ${CRUCIBLE_OWNER_REMOVAL_CAP} removals for this crucible. Ask a moderator to remove any other entries.`
          : `${removalsLeft} of ${CRUCIBLE_OWNER_REMOVAL_CAP} removals left for this crucible.`}
      </Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={() => closeAllModals()}>
          Keep it
        </Button>
        <Button
          color="red"
          disabled={!canSubmit}
          loading={removeEntry.isPending}
          onClick={() =>
            reason &&
            removeEntry.mutate({ entryId, reason, note: noteRequired ? note.trim() : undefined })
          }
        >
          Remove entry
        </Button>
      </Group>
    </Stack>
  );
}

export const openCrucibleOwnerRemoveEntryModal = (
  props: Parameters<typeof OwnerRemoveEntryForm>[0]
) =>
  openModal({
    title: 'Remove entry',
    centered: true,
    children: <OwnerRemoveEntryForm {...props} />,
  });
