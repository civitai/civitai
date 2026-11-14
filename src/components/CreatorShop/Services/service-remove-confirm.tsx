import { Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';

/** The seller's own Remove: the same confirmation wherever a service can be removed. */
export function confirmRemoveService({
  title,
  onConfirm,
}: {
  title: string;
  onConfirm: () => void;
}) {
  openConfirmModal({
    title: 'Remove service',
    children: (
      <Text size="sm">
        &quot;{title}&quot; leaves your shop for good. Open deals are not affected.
      </Text>
    ),
    labels: { confirm: 'Remove', cancel: 'Cancel' },
    confirmProps: { color: 'red' },
    onConfirm,
  });
}
