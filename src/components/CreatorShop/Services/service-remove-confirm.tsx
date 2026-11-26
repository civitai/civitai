import { Text } from '@mantine/core';
import { openConfirm } from '~/components/Dialog/Common/ConfirmDialog';

/** The seller's own Remove: the same confirmation wherever a service can be removed. */
export function confirmRemoveService({
  title,
  onConfirm,
}: {
  title: string;
  onConfirm: () => void;
}) {
  openConfirm({
    title: 'Remove service',
    message: (
      <Text size="sm">
        &quot;{title}&quot; leaves your shop for good. Open deals are not affected.
      </Text>
    ),
    labels: { confirm: 'Remove', cancel: 'Cancel' },
    confirmProps: { color: 'red' },
    onConfirm,
  });
}
