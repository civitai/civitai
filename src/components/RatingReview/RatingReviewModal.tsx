import { Badge, Button, Group, Modal, Select, Stack, Text, Textarea } from '@mantine/core';
import { useMemo, useState } from 'react';
import {
  ratingReviewLevelLabel,
  ratingReviewOwnerLevels,
  type RatingReviewEntityType,
} from '@civitai/shared/rating-review';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const COMMENT_MAX = 500;

export type RatingReviewModalProps = {
  entityType: RatingReviewEntityType;
  entityId: number;
  currentLevel: number;
  scanReason?: string | null;
  initialSuggestedLevel?: number;
};

export default function RatingReviewModal({
  entityType,
  entityId,
  currentLevel,
  scanReason,
  initialSuggestedLevel,
}: RatingReviewModalProps) {
  const dialog = useDialogContext();
  const queryUtils = trpc.useUtils();

  const options = useMemo(
    () => ratingReviewOwnerLevels(entityType, currentLevel),
    [entityType, currentLevel]
  );

  const levelOptions = useMemo(
    () =>
      options.map((level) => ({
        label:
          level === currentLevel
            ? `${ratingReviewLevelLabel(entityType, level)} (current)`
            : ratingReviewLevelLabel(entityType, level),
        value: String(level),
        disabled: level === currentLevel,
      })),
    [options, entityType, currentLevel]
  );

  const defaultLevel = useMemo(() => {
    if (
      initialSuggestedLevel &&
      options.includes(initialSuggestedLevel) &&
      initialSuggestedLevel !== currentLevel
    )
      return String(initialSuggestedLevel);
    const below = [...options].reverse().find((l) => l < currentLevel);
    return String(below ?? options.find((l) => l !== currentLevel) ?? options[0]);
  }, [options, currentLevel, initialSuggestedLevel]);

  const [suggestedLevel, setSuggestedLevel] = useState<string | null>(defaultLevel);
  const [comment, setComment] = useState('');

  const mutation = trpc.ratingReview.create.useMutation({
    onSuccess: async (data) => {
      await queryUtils.ratingReview.getMine.invalidate({ entityType, entityId });
      const message =
        data?.status === 'Actioned'
          ? 'Rating updated.'
          : 'Review submitted — a moderator will get back to you.';
      showSuccessNotification({ message });
      dialog.onClose();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Could not submit review',
        error: new Error(error.message),
      });
    },
  });

  const sameAsCurrent = suggestedLevel != null && Number(suggestedLevel) === currentLevel;

  const handleSubmit = () => {
    if (!suggestedLevel || sameAsCurrent) return;
    mutation.mutate({
      entityType,
      entityId,
      suggestedLevel: Number(suggestedLevel),
      userComment: comment.trim() ? comment.trim() : undefined,
    });
  };

  const commentLength = comment.length;

  return (
    <Modal {...dialog} title="Dispute rating" size="md">
      <Stack gap="md">
        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Current system rating
          </Text>
          <Group gap="xs">
            <Badge size="lg" variant="filled" color="gray">
              {ratingReviewLevelLabel(entityType, currentLevel)}
            </Badge>
            <Text size="xs" c="dimmed">
              Set from the content and any moderation decisions.
            </Text>
          </Group>
          {scanReason && (
            <Text size="xs" c="dimmed">
              Our text scan said: {scanReason}
            </Text>
          )}
        </Stack>
        <Select
          label="Suggested rating"
          description="What rating do you believe this should have?"
          data={levelOptions}
          value={suggestedLevel}
          onChange={setSuggestedLevel}
          allowDeselect={false}
          withAsterisk
        />
        <Stack gap={4}>
          <Textarea
            label="Comment"
            description="Optional. Explain why the current rating misrepresents the content."
            placeholder="e.g. The images are R but the description is PG-13…"
            value={comment}
            onChange={(event) => {
              const next = event.currentTarget.value.slice(0, COMMENT_MAX);
              setComment(next);
            }}
            minRows={4}
            maxRows={8}
            autosize
          />
          <Text size="xs" c={commentLength >= COMMENT_MAX ? 'red' : 'dimmed'} ta="right">
            {commentLength}/{COMMENT_MAX}
          </Text>
        </Stack>
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            loading={mutation.isPending}
            disabled={!suggestedLevel || sameAsCurrent}
          >
            Submit dispute
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
