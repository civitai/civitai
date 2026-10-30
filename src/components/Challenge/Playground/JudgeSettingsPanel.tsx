import {
  Button,
  Group,
  JsonInput,
  Loader,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { IconCopy, IconDeviceFloppy } from '@tabler/icons-react';
import {
  DEFAULT_JUDGING_ENGINE,
  isJudgingEngineKey,
  JUDGING_ENGINE_OPTIONS,
} from '~/server/games/daily-challenge/challenge-judging-engine';
import { JUDGE_USER_SELECTABLE_FIELD } from '~/shared/constants/challenge.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { ModelSelector } from './ModelSelector';
import { usePlaygroundStore } from './playground.store';
import { TemplateVariableIndicators } from './TemplateVariableIndicators';

export function JudgeSettingsPanel() {
  const selectedJudgeId = usePlaygroundStore((s) => s.selectedJudgeId);
  const drafts = usePlaygroundStore((s) => s.drafts);
  const updateDraft = usePlaygroundStore((s) => s.updateDraft);
  const clearDraft = usePlaygroundStore((s) => s.clearDraft);

  const { data: judge, isLoading } = trpc.challenge.getJudgeById.useQuery(
    { id: selectedJudgeId! },
    { enabled: selectedJudgeId != null && selectedJudgeId > 0 }
  );

  const setSelectedJudgeId = usePlaygroundStore((s) => s.setSelectedJudgeId);

  const queryUtils = trpc.useUtils();
  const upsertMutation = trpc.challenge.upsertJudge.useMutation({
    onSuccess: () => {
      showSuccessNotification({ message: 'Judge saved' });
      if (selectedJudgeId != null) clearDraft(selectedJudgeId);
      queryUtils.challenge.getJudges.invalidate();
      if (selectedJudgeId != null)
        queryUtils.challenge.getJudgeById.invalidate({ id: selectedJudgeId });
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const duplicateMutation = trpc.challenge.upsertJudge.useMutation({
    onSuccess: (created) => {
      showSuccessNotification({ message: 'Judge duplicated' });
      queryUtils.challenge.getJudges.invalidate();
      setSelectedJudgeId(created.id);
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const draft =
    selectedJudgeId != null && selectedJudgeId > 0 ? drafts[selectedJudgeId] : undefined;

  // Derive current values: draft overrides server data
  const currentName = draft?.name ?? judge?.name ?? '';
  const currentBio = draft?.bio ?? judge?.bio ?? '';
  const currentSystemPrompt = draft?.systemPrompt ?? judge?.systemPrompt ?? '';
  const currentContentPrompt = draft?.contentPrompt ?? judge?.contentPrompt ?? '';
  const currentReviewPrompt = draft?.reviewPrompt ?? judge?.reviewPrompt ?? '';
  const currentReviewTemplate = draft?.reviewTemplate ?? judge?.reviewTemplate ?? '';
  const currentWinnerPrompt = draft?.winnerSelectionPrompt ?? judge?.winnerSelectionPrompt ?? '';
  const currentUserSelectable = draft?.userSelectable ?? judge?.userSelectable ?? false;
  // An unrecognised stored value shows as the default rather than emptying the select — the same
  // fallback the judging path applies, so the picker never disagrees with what will actually run.
  const currentJudgingEngine =
    draft?.judgingEngine ??
    (isJudgingEngineKey(judge?.judgingEngine) ? judge.judgingEngine : DEFAULT_JUDGING_ENGINE);

  const handleSave = () => {
    if (!judge || selectedJudgeId == null) return;

    upsertMutation.mutate({
      id: selectedJudgeId,
      name: currentName,
      bio: currentBio || null,
      systemPrompt: currentSystemPrompt || null,
      contentPrompt: currentContentPrompt || null,
      reviewPrompt: currentReviewPrompt || null,
      reviewTemplate: currentReviewTemplate || null,
      winnerSelectionPrompt: currentWinnerPrompt || null,
      userSelectable: currentUserSelectable,
      judgingEngine: currentJudgingEngine,
    });
  };

  // Duplicates what is on screen, unsaved edits included, and never userSelectable: a new judge is
  // for trying an engine out, and inheriting the original's visibility would put it in front of
  // creators before anyone has looked at it.
  const handleDuplicate = () => {
    if (!judge) return;

    duplicateMutation.mutate({
      userId: judge.userId,
      name: `${currentName} (copy)`,
      bio: currentBio || null,
      sourceCollectionId: judge.sourceCollectionId,
      systemPrompt: currentSystemPrompt || null,
      contentPrompt: currentContentPrompt || null,
      reviewPrompt: currentReviewPrompt || null,
      reviewTemplate: currentReviewTemplate || null,
      winnerSelectionPrompt: currentWinnerPrompt || null,
      active: judge.active,
      userSelectable: false,
      judgingEngine: currentJudgingEngine,
    });
  };

  if (selectedJudgeId == null || selectedJudgeId < 0) {
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
            onChange={(e) => {
              if (selectedJudgeId != null)
                updateDraft(selectedJudgeId, { name: e.currentTarget.value });
            }}
          />
          <Textarea
            label="Bio"
            autosize
            minRows={2}
            maxRows={4}
            value={currentBio ?? ''}
            onChange={(e) => {
              if (selectedJudgeId != null)
                updateDraft(selectedJudgeId, { bio: e.currentTarget.value || null });
            }}
          />
          <Textarea
            label="System Prompt"
            autosize
            minRows={4}
            maxRows={12}
            value={currentSystemPrompt ?? ''}
            onChange={(e) => {
              if (selectedJudgeId != null)
                updateDraft(selectedJudgeId, { systemPrompt: e.currentTarget.value || null });
            }}
          />
          <Textarea
            label="Content Prompt"
            description="Used for challenge content generation"
            autosize
            minRows={3}
            maxRows={10}
            value={currentContentPrompt ?? ''}
            onChange={(e) => {
              if (selectedJudgeId != null)
                updateDraft(selectedJudgeId, { contentPrompt: e.currentTarget.value || null });
            }}
          />
          <Textarea
            label="Review Prompt"
            description="Used for image review scoring"
            autosize
            minRows={3}
            maxRows={10}
            value={currentReviewPrompt ?? ''}
            onChange={(e) => {
              if (selectedJudgeId != null)
                updateDraft(selectedJudgeId, { reviewPrompt: e.currentTarget.value || null });
            }}
          />
          <JsonInput
            label="Review Template (JSON)"
            description={<TemplateVariableIndicators value={currentReviewTemplate ?? ''} />}
            autosize
            minRows={4}
            maxRows={14}
            formatOnBlur
            validationError="Invalid JSON"
            styles={{ input: { fontFamily: 'monospace', fontSize: '12px' } }}
            value={currentReviewTemplate ?? ''}
            onChange={(value) => {
              if (selectedJudgeId != null)
                updateDraft(selectedJudgeId, { reviewTemplate: value || null });
            }}
          />
          <Textarea
            label="Winner Selection Prompt"
            description="Used for picking challenge winners"
            autosize
            minRows={3}
            maxRows={10}
            value={currentWinnerPrompt ?? ''}
            onChange={(e) => {
              if (selectedJudgeId != null)
                updateDraft(selectedJudgeId, {
                  winnerSelectionPrompt: e.currentTarget.value || null,
                });
            }}
          />
          <Select
            label="Judging Engine"
            description="Copied onto each new challenge assigned this judge; live challenges keep theirs"
            data={JUDGING_ENGINE_OPTIONS}
            value={currentJudgingEngine}
            allowDeselect={false}
            onChange={(value) => {
              if (selectedJudgeId != null && isJudgingEngineKey(value))
                updateDraft(selectedJudgeId, { judgingEngine: value });
            }}
          />
          <Switch
            label={JUDGE_USER_SELECTABLE_FIELD.label}
            description={JUDGE_USER_SELECTABLE_FIELD.description}
            checked={currentUserSelectable}
            onChange={(e) => {
              if (selectedJudgeId != null)
                updateDraft(selectedJudgeId, { userSelectable: e.currentTarget.checked });
            }}
          />
          <ModelSelector />
        </Stack>
      </ScrollArea>
      <Group m="sm" gap="xs" wrap="nowrap">
        <Button
          leftSection={<IconDeviceFloppy size={16} />}
          flex={1}
          onClick={handleSave}
          loading={upsertMutation.isPending}
          disabled={!currentName}
        >
          Save Judge
        </Button>
        <Button
          variant="default"
          leftSection={<IconCopy size={16} />}
          onClick={handleDuplicate}
          loading={duplicateMutation.isPending}
          disabled={!currentName}
        >
          Duplicate
        </Button>
      </Group>
    </Stack>
  );
}
