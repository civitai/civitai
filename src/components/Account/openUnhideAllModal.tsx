import { Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';

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
  openConfirmModal({
    title: `Unhide all ${plural}`,
    children: (
      <Text size="sm">
        {`This unhides all ${count.toLocaleString()} ${
          count === 1 ? noun : plural
        } at once and can't be undone in bulk. Your hidden tags, other hidden content and browsing level stay as they are.`}
      </Text>
    ),
    centered: true,
    labels: { confirm: `Unhide all ${plural}`, cancel: 'Cancel' },
    onConfirm,
  });
}
