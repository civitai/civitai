import { Button, Card, Code, ScrollArea, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons-react';
import { useState } from 'react';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { usePlaygroundStore } from './playground.store';

export function ReviewImageActivity() {
  const selectedJudgeId = usePlaygroundStore((s) => s.selectedJudgeId);
  const aiModel = usePlaygroundStore((s) => s.aiModel);
  const drafts = usePlaygroundStore((s) => s.drafts);
  const updateDraft = usePlaygroundStore((s) => s.updateDraft);

  const [imageUrl, setImageUrl] = useState('');
  const [theme, setTheme] = useState('');
  const [creator, setCreator] = useState('');
  const [userMessage, setUserMessage] = useState('');
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const draft = selectedJudgeId != null ? drafts[selectedJudgeId] : undefined;
  const reviewPrompt = draft?.reviewPrompt ?? '';

  const mutation = trpc.challenge.playgroundReviewImage.useMutation({
    onSuccess: (data) => setResult(data as Record<string, unknown>),
    onError: (error) => showErrorNotification({ error: new Error(error.message) }),
  });

  const handleRun = () => {
    if (!imageUrl || !theme) return;

    mutation.mutate({
      imageUrl,
      theme,
      creator: creator || undefined,
      judgeId: selectedJudgeId ?? undefined,
      promptOverrides:
        draft?.systemPrompt || draft?.reviewPrompt
          ? {
              systemMessage: draft?.systemPrompt ?? undefined,
              review: draft?.reviewPrompt ?? undefined,
            }
          : undefined,
      userMessage: userMessage || undefined,
      aiModel: aiModel || undefined,
    });
  };

  return (
    <Stack gap="sm" h="100%">
      <TextInput
        label="Image URL"
        placeholder="https://image.civitai.com/..."
        value={imageUrl}
        onChange={(e) => setImageUrl(e.currentTarget.value)}
        required
      />
      <TextInput
        label="Theme"
        placeholder="e.g. Cyberpunk"
        value={theme}
        onChange={(e) => setTheme(e.currentTarget.value)}
        required
      />
      <TextInput
        label="Creator"
        placeholder="Username (optional)"
        value={creator}
        onChange={(e) => setCreator(e.currentTarget.value)}
      />
      <Textarea
        label="Review Prompt (override)"
        placeholder="Leave empty to use judge's default"
        autosize
        minRows={3}
        maxRows={8}
        value={reviewPrompt}
        onChange={(e) =>
          selectedJudgeId != null &&
          updateDraft(selectedJudgeId, { reviewPrompt: e.currentTarget.value || null })
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
        disabled={!imageUrl || !theme}
      >
        Review Image
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
