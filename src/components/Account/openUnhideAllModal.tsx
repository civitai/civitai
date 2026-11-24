import { Text } from '@mantine/core';
import { openConfirm } from '~/components/Dialog/Common/ConfirmDialog';

export function openUnhideAllModal({
  noun,
  count,
  onConfirm,
}: {
  noun: 'model' | 'user';
  count: number;
  onConfirm: () => Promise<unknown>;
}) {
  const plural = `${noun}s`;
  openConfirm({
    title: `Unhide all ${plural}`,
    message: (
      <Text size="sm">
        {`This unhides all ${count.toLocaleString()} ${
          count === 1 ? noun : plural
        } at once and can't be undone in bulk. Your hidden tags, other hidden content and browsing level stay as they are.`}
      </Text>
    ),
    labels: { confirm: `Unhide all ${plural}`, cancel: 'Cancel' },
    onConfirm,
  });
}
