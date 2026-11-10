import {
  Alert,
  Button,
  Center,
  CloseButton,
  Group,
  Loader,
  Modal,
  Stack,
  Title,
} from '@mantine/core';
import { IconArrowUp } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { CommentComposer } from '~/components/CommentsV3/CommentComposer';
import { CommentItem, CommentReplies } from '~/components/CommentsV3/CommentItem';
import {
  CommentSectionProvider,
  useCommentSection,
} from '~/components/CommentsV3/CommentSectionContext';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { parseNumericString } from '~/utils/query-string-helpers';
import { trpc } from '~/utils/trpc';

/** One model comment's thread, opened from its card or a model-page link (`?dialog=commentThread`). */
export default function CommentThreadModal(props: {
  commentId: number | string;
  highlight?: number | string;
}) {
  // Routed-dialog props arrive from the URL as strings, an absent `highlight` as ''.
  const commentId = parseNumericString(props.commentId) || undefined;
  const highlight = parseNumericString(props.highlight) || undefined;
  const dialog = useDialogContext();
  const router = useRouter();
  const modelId = Number(router.query.id);
  // The model page's own input, so the dialog reads its cached model instead of fetching another.
  const { data: model } = trpc.model.getById.useQuery(
    { id: modelId, excludeTrainingData: true },
    { enabled: !!modelId }
  );
  const ownerId = model?.user.id;

  return (
    <Modal {...dialog} withCloseButton={false} size={800} padding="lg">
      <Group justify="flex-end" mb="xs">
        <CloseButton onClick={dialog.onClose} />
      </Group>
      {!!modelId && !!commentId && (
        <CommentSectionProvider
          entityType="model"
          entityId={modelId}
          ownerId={ownerId}
          badges={ownerId ? [{ userId: ownerId, label: 'OP', color: 'violet' }] : []}
          threadId={commentId}
          highlight={highlight}
        >
          <CommentThread />
        </CommentSectionProvider>
      )}
    </Modal>
  );
}

function CommentThread() {
  const { focusedId, byId, focusPending, focusedThread, locked, focus, threadMissing, created } =
    useCommentSection();
  if (threadMissing) return <Alert>This comment could not be found.</Alert>;

  const comment = focusedId ? byId.get(focusedId) : undefined;
  if (focusPending || !comment)
    return (
      <Center p="xl">
        <Loader type="bars" />
      </Center>
    );

  const parentId = focusedThread?.ancestorIds.at(-1);
  const threadLocked = locked || !!focusedThread?.locked;
  const replyCount = comment.replyCount + (created[comment.id]?.length ?? 0);

  return (
    <Stack gap="xl">
      {parentId && (
        <Button
          variant="subtle"
          size="compact-sm"
          className="self-start"
          leftSection={<IconArrowUp size={16} />}
          onClick={() => focus(parentId)}
        >
          View parent comment
        </Button>
      )}
      <CommentItem comment={comment} level={1} lockedAbove={threadLocked} repliesElsewhere />
      <Title order={3}>
        {`${replyCount.toLocaleString()} ${replyCount === 1 ? 'Comment' : 'Comments'}`}
      </Title>
      <CommentComposer parent={comment} />
      {/* The replies list insets itself to sit on a parent's reply rail, which has no rail here. */}
      {replyCount > 0 && (
        <div className="pl-3">
          <CommentReplies
            parent={comment}
            level={2}
            lockedAbove={threadLocked || comment.locked}
            pageInPlace
          />
        </div>
      )}
    </Stack>
  );
}
