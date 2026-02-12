import { Button, Card, Code, NumberInput, ScrollArea, Stack, Text, Textarea } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons-react';
import { useState } from 'react';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { usePlaygroundStore } from './playground.store';

export function GenerateContentActivity() {
  const selectedJudgeId = usePlaygroundStore((s) => s.selectedJudgeId);
  const aiModel = usePlaygroundStore((s) => s.aiModel);
  const drafts = usePlaygroundStore((s) => s.drafts);
  const updateDraft = usePlaygroundStore((s) => s.updateDraft);

  const [modelVersionId, setModelVersionId] = useState<number | undefined>();
  const [userMessage, setUserMessage] = useState('');
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const draft = selectedJudgeId != null ? drafts[selectedJudgeId] : undefined;
  const contentPrompt = draft?.contentPrompt ?? '';

  const mutation = trpc.challenge.playgroundGenerateContent.useMutation({
    onSuccess: (data) => setResult(data as Record<string, unknown>),
    onError: (error) => showErrorNotification({ error: new Error(error.message) }),
  });

  const handleRun = () => {
    if (!modelVersionId) return;

    mutation.mutate({
      modelVersionId,
      judgeId: selectedJudgeId ?? undefined,
      promptOverrides:
        draft?.systemPrompt || draft?.contentPrompt
          ? {
              systemMessage: draft?.systemPrompt ?? undefined,
              content: draft?.contentPrompt ?? undefined,
            }
          : undefined,
      userMessage: userMessage || undefined,
      aiModel: aiModel || undefined,
    });
  };

  return (
    <Stack gap="sm" h="100%">
      <NumberInput
        label="Model Version ID"
        placeholder="Enter a model version ID"
        value={modelVersionId}
        onChange={(val) => setModelVersionId(typeof val === 'number' ? val : undefined)}
      />
      <Textarea
        label="Content Prompt (override)"
        placeholder="Leave empty to use judge's default"
        autosize
        minRows={3}
        maxRows={8}
        value={contentPrompt}
        onChange={(e) =>
          selectedJudgeId != null &&
          updateDraft(selectedJudgeId, { contentPrompt: e.currentTarget.value || null })
        }
      />
      <Textarea
        label="User Message (override)"
        placeholder="Leave empty to use default"
        autosize
        minRows={2}
        maxRows={6}
        value={userMessage}
        onChange={(e) => setUserMessage(e.currentTarget.value)}
      />
      <Button
        leftSection={<IconPlayerPlay size={16} />}
        onClick={handleRun}
        loading={mutation.isLoading}
        disabled={!modelVersionId}
      >
        Generate Content
      </Button>

      {result && (
        <Card withBorder>
          <Text fw={600} size="sm" mb="xs">
            Result
          </Text>
          <ScrollArea mah={400}>
            <Code block>{JSON.stringify(result, null, 2)}</Code>
          </ScrollArea>
        </Card>
      )}
    </Stack>
  );
}
