/**
 * EnhancementDetails
 *
 * Shared component for displaying prompt enhancement results.
 * Used by both EnhanceTab (inline results) and HistoryTab (expanded card).
 * Shows prompt diffs, trigger words, recommendations, and issues.
 */

import { Badge, Group, Stack, Text } from '@mantine/core';
import type { PromptEnhancementRecord } from './promptEnhanceHooks';
import { PromptDiff } from './PromptDiff';

type EnhancementDetailsProps = {
  record: PromptEnhancementRecord;
};

export function EnhancementDetails({ record }: EnhancementDetailsProps) {
  const hasNoOutput = !record.enhancedPrompt;
  const statusLower = record.status.toLowerCase();
  const isComplete = statusLower === 'succeeded' || statusLower === 'failed';

  return (
    <Stack gap="sm">
      {hasNoOutput && (
        <Text size="xs" c="dimmed">
          {statusLower === 'succeeded'
            ? 'Enhancement produced no output. The request may have been refused.'
            : statusLower === 'failed'
            ? 'Enhancement failed'
            : 'Enhancement in progress'}
        </Text>
      )}

      {record.enhancedPrompt && (
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={4}>
            Prompt Changes
          </Text>
          <PromptDiff
            oldText={record.originalPrompt}
            newText={record.enhancedPrompt}
            triggerWords={record.preserveTriggerWords}
          />
        </div>
      )}

      {record.originalNegativePrompt && record.enhancedNegativePrompt && (
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={4}>
            Negative Prompt Changes
          </Text>
          <PromptDiff
            oldText={record.originalNegativePrompt}
            newText={record.enhancedNegativePrompt}
            triggerWords={record.preserveTriggerWords}
          />
        </div>
      )}

      {record.preserveTriggerWords && record.preserveTriggerWords.length > 0 && (
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={4}>
            Preserved Trigger Words
          </Text>
          <Group gap={6}>
            {record.preserveTriggerWords.map((word) => (
              <Badge key={word} size="xs" variant="light">
                {word}
              </Badge>
            ))}
          </Group>
        </div>
      )}

      {record.recommendations && record.recommendations.length > 0 && (
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={4}>
            Changes
          </Text>
          <Stack gap={2}>
            {record.recommendations.map((rec, i) => (
              <Text key={i} size="xs">
                {rec}
              </Text>
            ))}
          </Stack>
        </div>
      )}

      {record.issues && record.issues.length > 0 && (
        <div>
          <Text size="xs" fw={600} c="dimmed" mb={4}>
            {isComplete && hasNoOutput ? 'Issues' : 'Issues Addressed'}
          </Text>
          <Stack gap={2}>
            {record.issues.map((issue, i) => (
              <Group key={i} gap={6} wrap="nowrap">
                <Badge
                  size="xs"
                  color={
                    issue.severity === 'error'
                      ? 'red'
                      : issue.severity === 'warning'
                      ? 'yellow'
                      : 'blue'
                  }
                  variant="light"
                >
                  {issue.severity ?? 'info'}
                </Badge>
                <Text size="xs">{issue.description}</Text>
              </Group>
            ))}
          </Stack>
        </div>
      )}
    </Stack>
  );
}
