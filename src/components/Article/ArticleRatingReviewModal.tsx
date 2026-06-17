import { Anchor, Badge, Button, Group, Modal, Select, Stack, Text, Textarea } from '@mantine/core';
import { useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { constants } from '~/server/common/constants';
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
        label: getBrowsingLevelLabel(level),
        value: String(level),
      })),
    []
  );

  // Default to one severity step below the current rating (the most-likely-correct
  // dispute), but clamp to the lowest available level if the article is already PG.
  // When the caller knows the article was rescanned to a lower derived level
  // (stale-override banner path), honor that as the default instead.
  const defaultLevel = useMemo(() => {
    if (initialSuggestedLevel && browsingLevels.includes(initialSuggestedLevel as never)) {
      return String(initialSuggestedLevel);
    }
    const currentIndex = browsingLevels.findIndex((l) => l === currentLevel);
    if (currentIndex > 0) return String(browsingLevels[currentIndex - 1]);
    // currentLevel may be a composite (multi-bit) or unknown — fall back to
    // PG (lowest selectable) so the owner picks an explicit target.
    return String(browsingLevels[0]);
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

  const handleSubmit = () => {
    if (!suggestedLevel) return;
    mutation.mutate({
      articleId,
      suggestedLevel: Number(suggestedLevel),
      userComment: comment.trim() ? comment.trim() : undefined,
    });
  };

  const currentLabel = getBrowsingLevelLabel(currentLevel);
  const commentLength = comment.length;

  const guidelineUrl = constants.articleRatingGuidelineUrl;

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
        <Text size="xs" c="dimmed">
          Before submitting, review the{' '}
          <Anchor href={guidelineUrl} target="_blank" rel="noopener noreferrer">
            article rating guidelines
          </Anchor>{' '}
          to see what mods look at.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={mutation.isPending} disabled={!suggestedLevel}>
            Submit review
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
