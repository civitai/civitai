import { Stack, Text } from '@mantine/core';

export const DOWNLOAD_QUEUE_URL = '/generate/downloads';

const laneLabels: Record<string, string> = { high: 'Boosted', normal: 'Member', low: 'Standard' };

export function downloadLaneLabel(lane: string | null | undefined) {
  return lane ? laneLabels[lane] ?? lane : undefined;
}

/** Highlights the given versions on the queue page. */
export function downloadQueueHref(modelVersionIds: number[]) {
  return modelVersionIds.length
    ? `${DOWNLOAD_QUEUE_URL}?versions=${modelVersionIds.join(',')}`
    : DOWNLOAD_QUEUE_URL;
}

export function DownloadLanesExplainer() {
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        How the download queue works
      </Text>
      <Text size="xs">Downloads run in three lanes, each with its own reserved bandwidth:</Text>
      <Text size="xs">
        <b>Boosted</b> — anyone who pays to boost. Nothing overtakes a boosted download.
      </Text>
      <Text size="xs">
        <b>Member</b> — members, automatically.
      </Text>
      <Text size="xs">
        <b>Standard</b> — everyone else.
      </Text>
      <Text size="xs" c="dimmed">
        Within a lane your place never moves back, but a higher lane can go ahead of you — so
        outside the boosted lane, an ETA is an estimate.
      </Text>
    </Stack>
  );
}
