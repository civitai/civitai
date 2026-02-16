import {
  Badge,
  Button,
  Card,
  Group,
  Paper,
  Stack,
  Text,
  Textarea,
  TypographyStylesProvider,
} from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { ModelVersionMultiSelect } from '~/components/Challenge/ModelVersionMultiSelect';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { usePlaygroundStore } from './playground.store';

type GenerateResult = {
  title: string;
  content: string;
  invitation: string;
  theme: string;
};

export function GenerateContentActivity() {
  const selectedJudgeId = usePlaygroundStore((s) => s.selectedJudgeId);
  const aiModel = usePlaygroundStore((s) => s.aiModel);
  const drafts = usePlaygroundStore((s) => s.drafts);
  const updateDraft = usePlaygroundStore((s) => s.updateDraft);
  const { modelVersionIds, userMessage } = usePlaygroundStore((s) => s.generateContentInputs);
  const updateInputs = usePlaygroundStore((s) => s.updateGenerateContentInputs);

  const [result, setResult] = useState<GenerateResult | null>(null);

  const draft =
    selectedJudgeId != null && selectedJudgeId > 0 ? drafts[selectedJudgeId] : undefined;
  const contentPrompt = draft?.contentPrompt ?? '';

  const mutation = trpc.challenge.playgroundGenerateContent.useMutation({
    onSuccess: (data) => setResult(data as GenerateResult),
    onError: (error) => showErrorNotification({ error: new Error(error.message) }),
  });

  const handleRun = () => {
    const mvId = modelVersionIds[0];
    if (!mvId) return;

    setResult(null);
    mutation.mutate({
      modelVersionId: mvId,
      judgeId: selectedJudgeId != null && selectedJudgeId > 0 ? selectedJudgeId : undefined,
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

  const handleModelVersionChange = useCallback(
    (ids: number[]) => {
      updateInputs({ modelVersionIds: ids });
    },
    [updateInputs]
  );

  return (
    <Stack gap="sm">
      <ModelVersionMultiSelect
        label="Model Version"
        description="Select a model version to generate content for"
        value={modelVersionIds}
        onChange={handleModelVersionChange}
        maxSelections={1}
      />
      <Textarea
        label="Content Prompt (override)"
        placeholder="Leave empty to use judge's default"
        autosize
        minRows={3}
        maxRows={8}
        value={contentPrompt}
        onChange={(e) => {
          const id = selectedJudgeId != null && selectedJudgeId > 0 ? selectedJudgeId : null;
          if (id != null) updateDraft(id, { contentPrompt: e.currentTarget.value || null });
        }}
      />
      <Textarea
        label="User Message (override)"
        placeholder="Leave empty to use default (auto-generated from model info)"
        autosize
        minRows={2}
        maxRows={6}
        value={userMessage}
        onChange={(e) => updateInputs({ userMessage: e.currentTarget.value })}
      />
      <Button
        leftSection={<IconPlayerPlay size={16} />}
        onClick={handleRun}
        loading={mutation.isLoading}
        disabled={modelVersionIds.length === 0}
      >
        Generate Content
      </Button>

      {result && (
        <Card withBorder>
          <Stack gap="sm">
            <Text fw={600} size="sm">
              Title & Theme
            </Text>
            <Paper withBorder p="sm">
              <Group justify="space-between">
                <Text fw={600} size="lg">
                  {result.title}
                </Text>
                <Badge variant="light">{result.theme}</Badge>
              </Group>
            </Paper>
            <Text fw={600} size="sm">
              Invitation
            </Text>
            <Paper withBorder p="sm">
              <Text size="sm" fs="italic" c="dimmed">
                {result.invitation}
              </Text>
            </Paper>
            <Text fw={600} size="sm">
              Content
            </Text>
            <Paper withBorder p="sm">
              <TypographyStylesProvider>
                <div dangerouslySetInnerHTML={{ __html: result.content }} />
              </TypographyStylesProvider>
            </Paper>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
