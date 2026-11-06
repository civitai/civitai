import { Badge, Modal, Group, CloseButton, Alert, Center, Loader, Stack } from '@mantine/core';
import { IconExclamationCircle } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';

import { CommentSection } from '~/components/CommentSection/CommentSection';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CommentDiscussionMenu } from '~/components/Model/ModelDiscussion/CommentDiscussionMenu';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useToggleCommentReaction } from '~/components/CommentSection/useToggleCommentReaction';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export default function CommentThreadModal({
  commentId,
  highlight,
}: {
  commentId: number;
  highlight?: number;
}) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();

  const { data: comment, isLoading: commentLoading } = trpc.comment.getById.useQuery({
    id: commentId,
  });
  const { data: comments = [], isLoading: commentsLoading } = trpc.comment.getCommentsById.useQuery(
    {
      id: commentId,
    }
  );
  const { data: reactions = [] } = trpc.comment.getReactions.useQuery(
    { commentId },
    { enabled: !!comment, initialData: comment?.reactions }
  );
  const { data: model } = trpc.model.getById.useQuery(
    { id: comment?.modelId ?? -1 },
    { enabled: !!comment }
  );

  const toggleCommentReaction = useToggleCommentReaction(commentId);

  const loading = commentLoading || commentsLoading;

  return (
    <Modal {...dialog} withCloseButton={false} size={800}>
      {loading ? (
        <Center p="xl" style={{ height: 300 }}>
          <Loader />
        </Center>
      ) : !comment ? (
        <Alert>Comment could not be found</Alert>
      ) : (
        <Stack>
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <UserAvatar
              user={comment.user}
              subText={<DaysFromNow date={comment.createdAt} />}
              subTextForce
              badge={
                comment.user.id === model?.user.id ? (
                  <Badge size="xs" color="violet">
                    OP
                  </Badge>
                ) : null
              }
              size="lg"
              spacing="xs"
              withUsername
              linkToProfile
            />
            <Group gap={4} wrap="nowrap">
              <CommentDiscussionMenu comment={comment} modelUserId={model?.user.id} />
              <CloseButton onClick={dialog.onClose} />
            </Group>
          </Group>
          {currentUser?.isModerator && comment.tosViolation && (
            <AlertWithIcon color="yellow" iconColor="yellow" icon={<IconExclamationCircle />}>
              This comment has been marked with a TOS Violation. This is only visible for
              moderators.
            </AlertWithIcon>
          )}
          <Stack gap="xl">
            <RenderHtml html={comment.content} withMentions withProfanityFilter allowStickers />
            <ReactionPicker
              reactions={reactions}
              onSelect={(reaction) => toggleCommentReaction.toggle(reaction)}
            />
            <CommentSection
              comments={comments}
              modelId={comment.modelId}
              parent={comment}
              highlights={highlight ? [highlight] : undefined}
            />
          </Stack>
        </Stack>
      )}
    </Modal>
  );
}
