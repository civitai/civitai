import { Button, Loader, ScrollArea, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { IconDeviceFloppy } from '@tabler/icons-react';
import { useEffect } from 'react';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { ModelSelector } from './ModelSelector';
import { usePlaygroundStore } from './playground.store';

export function JudgeSettingsPanel() {
  const selectedJudgeId = usePlaygroundStore((s) => s.selectedJudgeId);
  const drafts = usePlaygroundStore((s) => s.drafts);
  const updateDraft = usePlaygroundStore((s) => s.updateDraft);
  const clearDraft = usePlaygroundStore((s) => s.clearDraft);

  const { data: judge, isLoading } = trpc.challenge.getJudgeById.useQuery(
    { id: selectedJudgeId! },
    { enabled: selectedJudgeId != null }
  );

  const queryUtils = trpc.useUtils();
  const upsertMutation = trpc.challenge.upsertJudge.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'Judge saved' });
      if (selectedJudgeId != null) clearDraft(selectedJudgeId);
      queryUtils.challenge.getJudges.invalidate();
      if (selectedJudgeId != null) queryUtils.challenge.getJudgeById.invalidate({ id: selectedJudgeId });
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const draft = selectedJudgeId != null ? drafts[selectedJudgeId] : undefined;

  // Derive current values: draft overrides server data
  const currentName = draft?.name ?? judge?.name ?? '';
  const currentBio = draft?.bio ?? judge?.bio ?? '';
  const currentSystemPrompt = draft?.systemPrompt ?? judge?.systemPrompt ?? '';

  const handleSave = () => {
    if (!judge && selectedJudgeId == null) return;

    upsertMutation.mutate({
      id: selectedJudgeId ?? undefined,
      userId: judge?.userId ?? 0,
      name: currentName,
      bio: currentBio || null,
      systemPrompt: currentSystemPrompt || null,
      contentPrompt: draft?.contentPrompt ?? judge?.contentPrompt ?? null,
      reviewPrompt: draft?.reviewPrompt ?? judge?.reviewPrompt ?? null,
      winnerSelectionPrompt: draft?.winnerSelectionPrompt ?? judge?.winnerSelectionPrompt ?? null,
    });
  };

  if (selectedJudgeId == null) {
    return (
      <Stack p="sm" align="center" justify="center" h="100%">
        <Text c="dimmed" size="sm" ta="center">
          Select a judge to edit settings
        </Text>
      </Stack>
    );
  }

  if (isLoading) {
    return (
      <Stack align="center" py="xl">
        <Loader size="sm" />
      </Stack>
    );
  }

  return (
    <Stack gap={0} h="100%">
      <Text fw={600} size="sm" p="sm" pb="xs">
        Judge Settings
      </Text>
      <ScrollArea flex={1} px="sm">
        <Stack gap="sm">
          <TextInput
            label="Name"
            value={currentName}
            onChange={(e) =>
              selectedJudgeId != null &&
              updateDraft(selectedJudgeId, { name: e.currentTarget.value })
            }
          />
          <Textarea
            label="Bio"
            autosize
            minRows={2}
            maxRows={4}
            value={currentBio ?? ''}
            onChange={(e) =>
              selectedJudgeId != null &&
              updateDraft(selectedJudgeId, { bio: e.currentTarget.value || null })
            }
          />
          <Textarea
            label="System Prompt"
            autosize
            minRows={4}
            maxRows={12}
            value={currentSystemPrompt ?? ''}
            onChange={(e) =>
              selectedJudgeId != null &&
              updateDraft(selectedJudgeId, { systemPrompt: e.currentTarget.value || null })
            }
          />
          <ModelSelector />
        </Stack>
      </ScrollArea>
      <Button
        leftSection={<IconDeviceFloppy size={16} />}
        m="sm"
        onClick={handleSave}
        loading={upsertMutation.isLoading}
      >
        Save Judge
      </Button>
    </Stack>
  );
}
