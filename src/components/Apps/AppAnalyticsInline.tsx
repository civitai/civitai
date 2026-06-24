import { Anchor, Group, Loader, Modal, Text, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconChartBar, IconInfoCircle } from '@tabler/icons-react';
import { useMemo } from 'react';
import { AppAnalyticsPanel } from '~/components/AppBlocks/AppAnalyticsPanel';
import dayjs from '~/shared/utils/dayjs';
import { trpc } from '~/utils/trpc';

/** Local mirror of the getMyAppAnalytics fields this inline stat reads (the
 *  full shape lives in AppAnalyticsPanel). */
type InlineAnalytics = {
  runs: { count: number };
  engagement: { activeUsers: number };
};

/**
 * Compact, per-approved-app analytics affordance for the /apps/my-submissions
 * list. Shows a small inline runs / unique-users (last 30d) stat and an
 * "Analytics" button that opens the existing AppAnalyticsPanel — scoped to THIS
 * app — in a modal. Reuses `blocks.getMyAppAnalytics` (the same query the
 * /apps/revenue dashboard panel runs) with a 30-day `from`; no new analytics
 * surface is built.
 *
 * Caveat (informational): runs/active-users undercount anonymous / no-scope
 * runs until the render-event instrumentation (#2695) deploys.
 */
export function AppAnalyticsInline({
  appBlockId,
  appLabel,
}: {
  appBlockId: string;
  appLabel: string;
}) {
  const [opened, { open, close }] = useDisclosure(false);

  // Last 30 days, app-scoped. Cheap aggregate the revenue dashboard already runs.
  const from = useMemo(() => dayjs().subtract(30, 'day').toISOString(), []);
  const statQuery = trpc.blocks.getMyAppAnalytics.useQuery(
    { appBlockId, from },
    { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false }
  );

  const data = statQuery.data as InlineAnalytics | undefined;

  return (
    <Group gap={8} wrap="nowrap" align="center">
      {statQuery.isLoading ? (
        <Loader size="xs" />
      ) : data ? (
        <Tooltip
          label="Runs and unique users in the last 30 days. Anonymous / no-scope runs are undercounted until render-event tracking ships."
          multiline
          maw={260}
          withinPortal
        >
          <Group gap={4} wrap="nowrap">
            <Text size="xs" fw={600}>
              {data.runs.count.toLocaleString()}
            </Text>
            <Text size="xs" c="dimmed">
              runs
            </Text>
            <Text size="xs" c="dimmed">
              ·
            </Text>
            <Text size="xs" fw={600}>
              {data.engagement.activeUsers.toLocaleString()}
            </Text>
            <Text size="xs" c="dimmed">
              users
            </Text>
            <IconInfoCircle size={12} style={{ opacity: 0.6 }} />
          </Group>
        </Tooltip>
      ) : (
        <Text size="xs" c="dimmed">
          —
        </Text>
      )}
      <Anchor component="button" type="button" size="xs" onClick={open}>
        <Group gap={2} wrap="nowrap">
          <IconChartBar size={12} />
          Analytics
        </Group>
      </Anchor>
      <Modal
        opened={opened}
        onClose={close}
        title={`Analytics — ${appLabel}`}
        size="xl"
      >
        {opened && <AppAnalyticsPanel scopedAppBlockId={appBlockId} />}
      </Modal>
    </Group>
  );
}
