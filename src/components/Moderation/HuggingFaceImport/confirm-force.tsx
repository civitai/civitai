import { Code, Stack, Text } from '@mantine/core';
import { openConfirm } from '~/components/Dialog/Common/ConfirmDialog';

/** Asks before forgetting an import whose stored parts or object could not be removed. */
export function confirmForce({
  action,
  what,
  message,
  onConfirm,
}: {
  action: 'Delete' | 'Restart';
  what: string;
  message: string;
  onConfirm: () => void;
}) {
  openConfirm({
    title: `${action} without cleaning up storage?`,
    labels: { confirm: `${action} anyway`, cancel: 'Keep it' },
    confirmProps: { color: 'red' },
    message: (
      <Stack gap="xs">
        <Text size="sm">
          We tried to remove what {what} already stored, and the storage service refused:
        </Text>
        <Code block>{message}</Code>
        <Text size="sm">
          Trying again later may work. {action} anyway to go ahead now — the leftover then stays in
          the bucket, and where it is gets logged so it can be removed by hand.
        </Text>
      </Stack>
    ),
    onConfirm,
  });
}
