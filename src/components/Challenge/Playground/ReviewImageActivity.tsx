import {
  Button,
  Card,
  Group,
  Progress,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons-react';
import { useState } from 'react';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { usePlaygroundStore } from './playground.store';

type ReviewResult = {
  score: { theme: number; wittiness: number; humor: number; aesthetic: number };
  reaction: string;
  comment: string;
  summary: string;
};

const SCORE_COLORS: Record<string, string> = {
  theme: 'blue',
  wittiness: 'grape',
  humor: 'yellow',
  aesthetic: 'teal',
};

/**
 * Parse image input that can be:
 * - A plain number (image ID)
 * - A civitai URL like https://civitai.com/images/12345
 * Returns the image ID or null if invalid.
 */
function parseImageInput(input: string): number | null {
  const trimmed = input.trim();

  // Try plain number
  const asNumber = Number(trimmed);
  if (!isNaN(asNumber) && asNumber > 0 && Number.isInteger(asNumber)) return asNumber;

  // Try civitai URL pattern: /images/{id}
  const match = trimmed.match(/civitai\.com\/images\/(\d+)/);
  if (match) return parseInt(match[1], 10);

  return null;
}

export function ReviewImageActivity() {
  const selectedJudgeId = usePlaygroundStore((s) => s.selectedJudgeId);
  const aiModel = usePlaygroundStore((s) => s.aiModel);
  const drafts = usePlaygroundStore((s) => s.drafts);
  const updateDraft = usePlaygroundStore((s) => s.updateDraft);
  const { imageInput, theme, creator, userMessage } = usePlaygroundStore(
    (s) => s.reviewImageInputs
  );
  const updateInputs = usePlaygroundStore((s) => s.updateReviewImageInputs);

  const [result, setResult] = useState<ReviewResult | null>(null);

  const draft =
    selectedJudgeId != null && selectedJudgeId > 0 ? drafts[selectedJudgeId] : undefined;
  const reviewPrompt = draft?.reviewPrompt ?? '';

  const parsedImageId = parseImageInput(imageInput);

  const mutation = trpc.challenge.playgroundReviewImage.useMutation({
    onSuccess: (data) => setResult(data as ReviewResult),
    onError: (error) => showErrorNotification({ error: new Error(error.message) }),
  });

  const handleRun = () => {
    if (!parsedImageId || !theme) return;

    setResult(null);
    mutation.mutate({
      imageId: parsedImageId,
      theme,
      creator: creator || undefined,
      judgeId: selectedJudgeId != null && selectedJudgeId > 0 ? selectedJudgeId : undefined,
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
    <Stack gap="sm">
      <TextInput
        label="Image"
        placeholder="Image ID or civitai.com/images/12345 URL"
        description="Enter a Civitai image ID or full image URL"
        value={imageInput}
        onChange={(e) => updateInputs({ imageInput: e.currentTarget.value })}
        error={
          imageInput && !parsedImageId ? 'Enter a valid image ID or civitai image URL' : undefined
        }
        required
      />
      <TextInput
        label="Theme"
        placeholder="e.g. Cyberpunk"
        value={theme}
        onChange={(e) => updateInputs({ theme: e.currentTarget.value })}
        required
      />
      <TextInput
        label="Creator"
        placeholder="Username (optional — auto-detected from image if empty)"
        value={creator}
        onChange={(e) => updateInputs({ creator: e.currentTarget.value })}
      />
      <Textarea
        label="Review Prompt (override)"
        placeholder="Leave empty to use judge's default"
        autosize
        minRows={3}
        maxRows={8}
        value={reviewPrompt}
        onChange={(e) => {
          const id = selectedJudgeId != null && selectedJudgeId > 0 ? selectedJudgeId : null;
          if (id != null) updateDraft(id, { reviewPrompt: e.currentTarget.value || null });
        }}
      />
      <Textarea
        label="User Message (override)"
        placeholder="Leave empty to use default (Theme + Creator)"
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
        disabled={!parsedImageId || !theme}
      >
        Review Image
      </Button>

      {result && (
        <Card withBorder>
          <Stack gap="sm">
            <Text fw={600} size="sm">
              Scores
            </Text>
            {Object.entries(result.score).map(([key, value]) => (
              <div key={key}>
                <Group justify="space-between" mb={4}>
                  <Text size="xs" tt="capitalize">
                    {key}
                  </Text>
                  <Text size="xs" fw={600}>
                    {value}/10
                  </Text>
                </Group>
                <Progress value={value * 10} color={SCORE_COLORS[key] ?? 'blue'} size="sm" />
              </div>
            ))}
            <Group gap="xs">
              <Text size="sm" fw={600}>
                Reaction:
              </Text>
              <Text size="sm">{result.reaction}</Text>
            </Group>
            <div>
              <Text size="sm" fw={600} mb={4}>
                Comment
              </Text>
              <Text size="sm">{result.comment}</Text>
            </div>
            <div>
              <Text size="sm" fw={600} mb={4}>
                Summary
              </Text>
              <Text size="sm" c="dimmed">
                {result.summary}
              </Text>
            </div>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
