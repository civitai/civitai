import { ActionIcon, Button, Group, Stack, Text } from '@mantine/core';
import { IconClockPause, IconExternalLink } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import {
  TRAINING_REVIEW_COPY as copy,
  canRaiseTrainingReview,
  trainingReviewPendingBody,
} from '@civitai/shared/training-review';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { Tooltip } from '~/components/MantineOverlays';
import { SUPPORT_LINKS } from '~/components/Support/support.constants';

/** The classic trainer's view of a run held for review: the expected wait and, once the run has
 *  waited long enough, a way to raise it with support. */
export function TrainingReviewNotice({
  heldSince,
  runId,
  completedEpochs,
  plannedEpochs,
}: {
  heldSince: string | null;
  runId: string;
  completedEpochs: number;
  plannedEpochs: number | null | undefined;
}) {
  // Re-read the clock once a minute so a page left open offers the raise when the threshold passes.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const canRaise = canRaiseTrainingReview(heldSince, now);

  return (
    <Stack p="xl" align="center" gap="xs" data-testid="training-review-notice">
      <IconClockPause size={52} />
      <Text fw={600}>{copy.pendingTitle}</Text>
      <Text ta="center" maw={480}>
        {trainingReviewPendingBody(completedEpochs, plannedEpochs)}
      </Text>
      {canRaise && (
        <>
          <Text ta="center" maw={480} mt="sm">
            {copy.raiseBody}
          </Text>
          <Group gap={4}>
            <Text size="sm" ff="monospace">
              Run ID: {runId}
            </Text>
            <CopyButton value={runId}>
              {({ copy: copyId, copied, Icon, color }) => (
                <Tooltip label={copied ? 'Copied' : 'Copy run ID'} withArrow>
                  <ActionIcon variant="subtle" color={color} onClick={copyId}>
                    <Icon size={16} />
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          </Group>
          <Button
            component="a"
            href={SUPPORT_LINKS.portal}
            target="_blank"
            rel="noreferrer"
            variant="light"
            rightSection={<IconExternalLink size={16} />}
          >
            {copy.contactSupport}
          </Button>
        </>
      )}
    </Stack>
  );
}
