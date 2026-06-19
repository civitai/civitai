import { Badge, Button, Group, Modal, Select, Stack, Text, Textarea } from '@mantine/core';
import { useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { browsingLevels, getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const COMMENT_MAX = 500;

export type ArticleRatingReviewModalProps = {
  articleId: number;
  currentLevel: number;
  /**
   * When the article's content has been edited and the system-derived rating
   * has dropped below the active moderator override, the article page passes
   * the derived level in so the modal pre-selects it as the suggested rating
   * (owner doesn't have to guess what the rescan landed on).
   */
  initialSuggestedLevel?: number;
};

export default function ArticleRatingReviewModal({
  articleId,
  currentLevel,
  initialSuggestedLevel,
}: ArticleRatingReviewModalProps) {
  const dialog = useDialogContext();
  const queryUtils = trpc.useUtils();

  const levelOptions = useMemo(
    () =>
      browsingLevels.map((level) => ({
        // `getBrowsingLevelLabel` handles composite/unknown values gracefully
        // by falling back to the highest set bit; direct map access on
        // `browsingLevelLabels` returns undefined for those and produces an
        // empty Select label.
        label:
          level === currentLevel
            ? `${getBrowsingLevelLabel(level)} (current)`
            : getBrowsingLevelLabel(level),
        value: String(level),
        // A review that suggests the rating the article already has is a no-op,
        // so the current level is unpickable. Server enforces the same rule.
        disabled: level === currentLevel,
      })),
    [currentLevel]
  );

  // Default to one severity step below the current rating (the most-likely-correct
  // dispute), but clamp to the lowest available level if the article is already PG.
  // When the caller knows the article was rescanned to a lower derived level
  // (stale-override banner path), honor that as the default instead.
  const defaultLevel = useMemo(() => {
    if (
      initialSuggestedLevel &&
      browsingLevels.includes(initialSuggestedLevel as never) &&
      initialSuggestedLevel !== currentLevel
    ) {
      return String(initialSuggestedLevel);
    }
    const currentIndex = browsingLevels.findIndex((l) => l === currentLevel);
    if (currentIndex > 0) return String(browsingLevels[currentIndex - 1]);
    // Current is the lowest selectable level (or a composite/unknown value) —
    // there's nothing lower to suggest, so default to the first level that
    // isn't the current one. Never default to the current level: it's disabled
    // in the Select and rejected server-side.
    const firstDifferent = browsingLevels.find((l) => l !== currentLevel);
    return String(firstDifferent ?? browsingLevels[0]);
  }, [currentLevel, initialSuggestedLevel]);

  const [suggestedLevel, setSuggestedLevel] = useState<string | null>(defaultLevel);
  const [comment, setComment] = useState('');

  const mutation = trpc.article.createRatingReview.useMutation({
    onSuccess: async (data) => {
      await queryUtils.article.getMyArticleRatingReview.invalidate({ articleId });
      // The mutation may have auto-resolved when a rescan agreed with the
      // suggested level — tailor the toast so the owner sees the right state
      // (immediate update vs queued for mod review).
      const message =
        data?.status === 'Actioned'
          ? 'Rating updated — your article now reflects the new rating.'
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
      articleId,
      suggestedLevel: Number(suggestedLevel),
      userComment: comment.trim() ? comment.trim() : undefined,
    });
  };

  const currentLabel = getBrowsingLevelLabel(currentLevel);
  const commentLength = comment.length;

  return (
    <Modal {...dialog} title="Request rating review" size="md">
      <Stack gap="md">
        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Current system rating
          </Text>
          <Group gap="xs">
            <Badge size="lg" variant="filled" color="gray">
              {currentLabel}
            </Badge>
            <Text size="xs" c="dimmed">
              Derived from your article&apos;s content and any active moderation overrides.
            </Text>
          </Group>
        </Stack>
        <Select
          label="Suggested rating"
          description="What rating do you believe this article should have?"
          data={levelOptions}
          value={suggestedLevel}
          onChange={setSuggestedLevel}
          allowDeselect={false}
          withAsterisk
        />
        <Stack gap={4}>
          <Textarea
            label="Comment"
            description="Optional. Explain why the current rating misrepresents the article."
            placeholder="e.g. The body images are R but the cover and topic are PG-13…"
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
            Submit review
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
