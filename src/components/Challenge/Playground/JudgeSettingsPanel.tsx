import { Button, Loader, ScrollArea, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { IconDeviceFloppy } from '@tabler/icons-react';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { ModelSelector } from './ModelSelector';
import { usePlaygroundStore } from './playground.store';

export function JudgeSettingsPanel() {
  const selectedJudgeId = usePlaygroundStore((s) => s.selectedJudgeId);
  const drafts = usePlaygroundStore((s) => s.drafts);
  const updateDraft = usePlaygroundStore((s) => s.updateDraft);
  const clearDraft = usePlaygroundStore((s) => s.clearDraft);
  const setSelectedJudgeId = usePlaygroundStore((s) => s.setSelectedJudgeId);

  const { data: judge, isLoading } = trpc.challenge.getJudgeById.useQuery(
    { id: selectedJudgeId! },
    { enabled: selectedJudgeId != null }
  );

  const queryUtils = trpc.useUtils();
  const upsertMutation = trpc.challenge.upsertJudge.useMutation({
    onSuccess: (data) => {
      showSuccessNotification({ message: 'Judge saved' });
      if (selectedJudgeId != null) clearDraft(selectedJudgeId);
      else setSelectedJudgeId(data.id);
      queryUtils.challenge.getJudges.invalidate();
      if (selectedJudgeId != null)
        queryUtils.challenge.getJudgeById.invalidate({ id: selectedJudgeId });
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const isNewJudge = selectedJudgeId === -1;
  const draft = selectedJudgeId != null && selectedJudgeId > 0 ? drafts[selectedJudgeId] : undefined;

  // Derive current values: draft overrides server data
  const currentName = isNewJudge ? drafts[-1]?.name ?? '' : (draft?.name ?? judge?.name ?? '');
  const currentBio = isNewJudge ? drafts[-1]?.bio ?? '' : (draft?.bio ?? judge?.bio ?? '');
  const currentSystemPrompt = isNewJudge
    ? drafts[-1]?.systemPrompt ?? ''
    : (draft?.systemPrompt ?? judge?.systemPrompt ?? '');

  const handleSave = () => {
    if (isNewJudge) {
      upsertMutation.mutate({
        name: currentName,
        bio: currentBio || null,
        systemPrompt: currentSystemPrompt || null,
        contentPrompt: drafts[-1]?.contentPrompt ?? null,
        reviewPrompt: drafts[-1]?.reviewPrompt ?? null,
        winnerSelectionPrompt: drafts[-1]?.winnerSelectionPrompt ?? null,
      });
      return;
    }

    if (!judge || selectedJudgeId == null) return;

    upsertMutation.mutate({
      id: selectedJudgeId,
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

  if (!isNewJudge && isLoading) {
    return (
      <Stack align="center" py="xl">
        <Loader size="sm" />
      </Stack>
    );
  }

  const activeDraft = isNewJudge ? drafts[-1] : draft;

  return (
    <Stack gap={0} h="100%">
      <Text fw={600} size="sm" p="sm" pb="xs">
        {isNewJudge ? 'New Judge' : 'Judge Settings'}
      </Text>
      <ScrollArea flex={1} px="sm">
        <Stack gap="sm">
          <TextInput
            label="Name"
            value={currentName}
            onChange={(e) => {
              const id = isNewJudge ? -1 : selectedJudgeId;
              if (id != null) updateDraft(id, { name: e.currentTarget.value });
            }}
          />
          <Textarea
            label="Bio"
            autosize
            minRows={2}
            maxRows={4}
            value={currentBio ?? ''}
            onChange={(e) => {
              const id = isNewJudge ? -1 : selectedJudgeId;
              if (id != null) updateDraft(id, { bio: e.currentTarget.value || null });
            }}
          />
          <Textarea
            label="System Prompt"
            autosize
            minRows={4}
            maxRows={12}
            value={currentSystemPrompt ?? ''}
            onChange={(e) => {
              const id = isNewJudge ? -1 : selectedJudgeId;
              if (id != null) updateDraft(id, { systemPrompt: e.currentTarget.value || null });
            }}
          />
          <ModelSelector />
        </Stack>
      </ScrollArea>
      <Button
        leftSection={<IconDeviceFloppy size={16} />}
        m="sm"
        onClick={handleSave}
        loading={upsertMutation.isLoading}
        disabled={!currentName}
      >
        {isNewJudge ? 'Create Judge' : 'Save Judge'}
      </Button>
    </Stack>
  );
}
