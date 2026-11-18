import { Button, Group, Stack, Text } from '@mantine/core';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * On /apps/activity, under an app's daily limit: shown only while the viewer lets the app run
 * above-budget jobs without asking. Shows today's spend against the limit and turns it off.
 */
export function AppConfirmWithinLimitControl({ appBlockId }: { appBlockId: string }) {
  const utils = trpc.useUtils();
  const { data } = trpc.blocks.getMyConfirmWithinLimit.useQuery({ appBlockId });
  const optOut = trpc.blocks.optOutConfirmWithinLimit.useMutation({
    onSuccess: async () => {
      await utils.blocks.getMyConfirmWithinLimit.invalidate({ appBlockId });
      await utils.blocks.getMyAppDailyLimit.invalidate({ appBlockId });
    },
    onError: (e) =>
      showErrorNotification({ title: 'Could not change this', error: new Error(e.message) }),
  });
  if (!data) return null;
  return (
    <Group justify="space-between" gap="xs" wrap="nowrap" data-testid="app-confirm-within-limit">
      <Stack gap={0}>
        <Text size="xs">
          Runs jobs up to {data.maxJob.toLocaleString()} Buzz without asking, within this limit.
        </Text>
        <Text size="xs" c="dimmed" data-testid="app-confirm-within-limit-spend">
          {data.spentToday.toLocaleString()} of {data.limit.toLocaleString()} Buzz spent today
        </Text>
      </Stack>
      <Button
        size="compact-xs"
        variant="subtle"
        loading={optOut.isPending}
        onClick={() => optOut.mutate({ appBlockId })}
        data-testid="app-confirm-within-limit-off"
      >
        Ask me each job
      </Button>
    </Group>
  );
}
