import {
  Alert,
  Button,
  Chip,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
} from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { NsfwLevel } from '~/server/common/enums';
import { browsingLevelLabels, browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { AI_REVIEW_MODELS } from '~/server/schema/collection.schema';
import type { CollectionAiReviewSchema } from '~/server/schema/collection.schema';
import { DEFAULT_AI_REVIEW_PROMPT } from '~/server/services/ai/collection-review.prompt';
import { Flags } from '~/shared/utils/flags';

export default function CollectionAiReviewModal({ collectionId }: { collectionId: number }) {
  const dialog = useDialogContext();
  const { data: collection, isLoading } = trpc.collection.getById.useQuery({ id: collectionId });
  const existing = (collection?.collection?.metadata as { aiReview?: CollectionAiReviewSchema })
    ?.aiReview;

  return (
    <Modal {...dialog} title="AI moderation" size="lg">
      {isLoading ? (
        <Group justify="center" p="xl">
          <Loader />
        </Group>
      ) : (
        <AiReviewForm collectionId={collectionId} existing={existing} onClose={dialog.onClose} />
      )}
    </Modal>
  );
}

function AiReviewForm({
  collectionId,
  existing,
  onClose,
}: {
  collectionId: number;
  existing?: CollectionAiReviewSchema;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();

  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const [dryRun, setDryRun] = useState(existing?.dryRun ?? true);
  const [model, setModel] = useState<string>(existing?.model ?? AI_REVIEW_MODELS[0]);
  const [prompt, setPrompt] = useState(existing?.prompt ?? DEFAULT_AI_REVIEW_PROMPT);
  const [allowedNsfwLevels, setAllowedNsfwLevels] = useState(
    existing?.allowedNsfwLevels ?? Flags.arrayToInstance([NsfwLevel.PG, NsfwLevel.PG13])
  );
  const [escalationAction, setEscalationAction] = useState<string>(
    existing?.escalationAction ?? 'reject'
  );

  const saveMutation = trpc.collection.setAiReview.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'AI moderation settings saved' });
      await utils.collection.getById.invalidate({ id: collectionId });
      onClose();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not save settings', error: new Error(error.message) }),
  });

  const selectedLevels = Flags.instanceToArray(allowedNsfwLevels).map(String);

  return (
    <Stack gap="md">
      <Switch
        label="Enable AI review"
        description="Reviews pending submissions on a schedule."
        checked={enabled}
        onChange={(e) => setEnabled(e.currentTarget.checked)}
      />

      <Switch
        label="Dry run"
        description="Classify and log decisions without changing any submission's status."
        checked={dryRun}
        onChange={(e) => setDryRun(e.currentTarget.checked)}
      />

      <Select
        label="Model"
        data={AI_REVIEW_MODELS.map((value) => ({ value, label: value }))}
        value={model}
        onChange={(value) => value && setModel(value)}
      />

      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Allowed ratings
        </Text>
        <Text size="xs" c="dimmed">
          Anything rated outside these is rejected without being sent to the model.
        </Text>
        <Chip.Group
          multiple
          value={selectedLevels}
          onChange={(values) => setAllowedNsfwLevels(Flags.arrayToInstance(values.map(Number)))}
        >
          <Group gap={4} mt={4}>
            {browsingLevels.map((level) => (
              <Chip key={level} value={String(level)} size="xs">
                {browsingLevelLabels[level]}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      </Stack>

      <Select
        label="When the model is unsure"
        description="Applies to flags the model isn't confident about, like borderline styling."
        data={[
          { value: 'reject', label: 'Reject the submission' },
          { value: 'leaveForHuman', label: 'Leave in review for a human' },
        ]}
        value={escalationAction}
        onChange={(value) => value && setEscalationAction(value)}
      />

      <Textarea
        label="Prompt"
        description="Sent as the system prompt. It must ask for the JSON fields the rules engine expects."
        autosize
        minRows={6}
        maxRows={16}
        value={prompt}
        onChange={(e) => setPrompt(e.currentTarget.value)}
        styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
      />

      {enabled && !dryRun && (
        <Alert color="yellow">
          Decisions will be applied automatically and submitters will be notified.
        </Alert>
      )}

      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={saveMutation.isPending}
          disabled={!prompt.trim() || !allowedNsfwLevels}
          onClick={() =>
            saveMutation.mutate({
              collectionId,
              aiReview: {
                enabled,
                dryRun,
                model: model as CollectionAiReviewSchema['model'],
                prompt,
                allowedNsfwLevels,
                escalationAction: escalationAction as CollectionAiReviewSchema['escalationAction'],
                reasonCopy: existing?.reasonCopy,
              },
            })
          }
        >
          Save
        </Button>
      </Group>
    </Stack>
  );
}
