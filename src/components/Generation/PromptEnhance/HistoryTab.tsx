import { Badge, Button, Card, Group, Loader, ScrollArea, Stack, Text } from '@mantine/core';
import { IconChevronDown, IconChevronUp, IconSparkles } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useGetPromptEnhancementHistory, type PromptEnhancementRecord } from './promptEnhanceHooks';
import { PromptDiff, computeWordDiff } from './PromptDiff';

type HistoryTabProps = {
  onApply: (enhancedPrompt: string, enhancedNegativePrompt?: string) => void;
};

export function HistoryTab({ onApply }: HistoryTabProps) {
  const {
    data: records,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useGetPromptEnhancementHistory();

  if (isLoading) {
    return (
      <Stack align="center" justify="center" className="flex-1" gap="md">
        <Loader size="md" />
        <Text c="dimmed" size="sm">
          Loading history...
        </Text>
      </Stack>
    );
  }

  if (!records.length) {
    return (
      <Stack align="center" justify="center" className="flex-1" gap="md" p="md">
        <Text c="dimmed" size="sm" ta="center">
          No prompt enhancements yet. Use the Enhance tab to get started.
        </Text>
      </Stack>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <Stack gap="xs" p="md">
        {records.map((record) => (
          <HistoryItem key={record.workflowId} record={record} onApply={onApply} />
        ))}
        {hasNextPage && (
          <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetchingNextPage}>
            <Loader size="sm" mx="auto" />
          </InViewLoader>
        )}
      </Stack>
    </ScrollArea>
  );
}

function HistoryItem({
  record,
  onApply,
}: {
  record: PromptEnhancementRecord;
  onApply: (enhancedPrompt: string, enhancedNegativePrompt?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const dialog = useDialogContext();

  const date = new Date(record.createdAt);
  const timeStr = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  // Compute a short summary of what was added in the diff
  const addedSummary = useMemo(() => {
    if (!record.enhancedPrompt) return null;
    const segments = computeWordDiff(record.originalPrompt, record.enhancedPrompt);
    const firstAdded = segments.find((s) => s.type === 'added');
    if (!firstAdded) return null;
    const trimmed = firstAdded.value.trim();
    return trimmed.length > 60 ? trimmed.slice(0, 60) + '...' : trimmed;
  }, [record.originalPrompt, record.enhancedPrompt]);

  const handleApply = () => {
    if (record.enhancedPrompt) {
      onApply(record.enhancedPrompt, record.enhancedNegativePrompt);
      dialog.onClose();
    }
  };

  return (
    <Card withBorder padding="xs" radius="sm">
      {/* Compact row */}
      <Group
        justify="space-between"
        wrap="nowrap"
        className="cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="min-w-0 flex-1">
          <Group gap={6} mb={2}>
            <Text size="xs" c="dimmed">
              {timeStr}
            </Text>
            {record.ecosystem && (
              <Badge size="xs" variant="light">
                {record.ecosystem}
              </Badge>
            )}
          </Group>
          {record.instruction ? (
            <Text size="sm" lineClamp={2}>
              {record.instruction}
            </Text>
          ) : (
            <Text size="sm" c="dimmed" truncate fs="italic">
              No instructions
            </Text>
          )}
          {addedSummary && (
            <Text size="xs" c="green" truncate mt={2}>
              +{addedSummary}
            </Text>
          )}
        </div>
        {expanded ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
      </Group>

      {/* Expanded content */}
      {expanded && (
        <Stack gap="sm" mt="sm">
          {record.enhancedPrompt ? (
            <>
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
                    Issues Addressed
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

              <Group justify="flex-end">
                <Button
                  size="compact-sm"
                  onClick={handleApply}
                  leftSection={<IconSparkles size={14} />}
                >
                  Apply
                </Button>
              </Group>
            </>
          ) : (
            <Text size="xs" c="dimmed">
              Enhancement {record.status === 'failed' ? 'failed' : 'in progress'}
            </Text>
          )}
        </Stack>
      )}
    </Card>
  );
}
