import { Group, Badge, Stack, LoadingOverlay, CloseButton, Title } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { CommentProvider } from '~/components/CommentsV2/Comment/CommentProvider';
import { CommentReactions } from '~/components/CommentsV2/Comment/CommentReactions';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { ModelDiscussionContextMenu } from '~/components/Model/Discussion/ModelDiscussionContextMenu';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { trpc } from '~/utils/trpc';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ModelDiscussionComments } from '~/components/Model/Discussion/ModelDiscussionComments';
import { Thread } from '@prisma/client';
import { NavigateBack } from '~/components/BackButton/BackButton';

export function ModelDiscussionDetail({
  commentId,
  modelId,
}: {
  commentId: number;
  modelId?: number;
}) {
  const { data, isLoading } = trpc.commentv2.getSingle.useQuery({ id: commentId });
  const returnUrl = data?.thread ? getReturnUrl(data.thread) : '/';

  return (
    <div style={{ position: 'relative', minHeight: 200 }}>
      <LoadingOverlay visible={isLoading} />
      {!isLoading && data ? (
        <CommentProvider comment={data}>
          <Stack>
            <Group position="apart">
              <UserAvatar
                user={data.user}
                subText={<DaysFromNow date={data.createdAt} />}
                subTextForce
                badge={
                  data.user.id === modelId ? (
                    <Badge size="xs" color="violet">
                      OP
                    </Badge>
                  ) : null
                }
                withUsername
                linkToProfile
              />
              <Group spacing={4} noWrap>
                <ModelDiscussionContextMenu />
                <NavigateBack url={returnUrl}>
                  {({ onClick }) => <CloseButton onClick={onClick} />}
                </NavigateBack>
              </Group>
            </Group>
            <RenderHtml html={data.content} sx={(theme) => ({ fontSize: theme.fontSizes.sm })} />
            <CommentReactions comment={data} />
          </Stack>
        </CommentProvider>
      ) : (
        <NotFound />
      )}
      <Stack spacing="xl">
        <Group position="apart">
          <Title order={3}>{`${data?.childThread?._count.comments.toLocaleString()} ${
            data?.childThread?._count.comments === 1 ? 'Comment' : 'Comments'
          }`}</Title>
        </Group>
        <ModelDiscussionComments commentId={commentId} userId={data?.user.id} />
      </Stack>
    </div>
  );
}

const getReturnUrl = ({ postId, modelId, questionId, answerId, commentId, reviewId }: Thread) => {
  if (modelId) return `/models/${modelId}`;
  return '';
};
