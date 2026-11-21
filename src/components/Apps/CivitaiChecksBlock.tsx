import { Alert, Badge, Group, List, Stack, Text } from '@mantine/core';
import { IconShieldCheck } from '@tabler/icons-react';
import {
  civitaiCheckLines,
  STALE_REVIEW_STATEMENT,
  type ConnectCivitaiChecksView,
} from '~/shared/constants/connect-agent-review.constants';

/**
 * The agent review's "Checked by Civitai" block (connect lane): facts Civitai computed itself,
 * from `AppReviewAgentReportCheck` — a table only the dispatch writes. Rendered apart from the
 * runner's report on purpose: nothing the runner emits can appear in here, however closely it
 * imitates a line. Shows the stale notice when the listing changed after the review.
 */
export function CivitaiChecksBlock({ view }: { view: ConnectCivitaiChecksView }) {
  const lines = civitaiCheckLines(view.checks);
  return (
    <Alert
      color="gray"
      variant="light"
      icon={<IconShieldCheck size={14} />}
      data-testid="apps-agent-civitai-checks"
      title={
        <Group gap={6}>
          <Text size="xs" fw={600}>
            Checked by Civitai, not by the review agent
          </Text>
          {view.stale && (
            <Badge size="xs" color="orange" variant="light" data-testid="apps-agent-review-stale">
              stale
            </Badge>
          )}
        </Group>
      }
    >
      <Stack gap={4}>
        {view.stale && (
          <Text size="xs" c="orange" fw={600}>
            {STALE_REVIEW_STATEMENT}
          </Text>
        )}
        <List size="xs" spacing={2}>
          {lines.map((line) => (
            <List.Item key={line.text}>
              <Text size="xs" fw={line.tone === 'warn' ? 600 : 400}>
                {line.text}
              </Text>
            </List.Item>
          ))}
        </List>
      </Stack>
    </Alert>
  );
}
