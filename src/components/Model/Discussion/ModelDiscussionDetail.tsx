import { Group, Badge, Stack, LoadingOverlay } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { CommentProvider } from '~/components/CommentsV2/Comment/CommentProvider';
import { CommentReactions } from '~/components/CommentsV2/Comment/CommentReactions';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { ModelDiscussionContextMenu } from '~/components/Model/Discussion/ModelDiscussionContextMenu';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { trpc } from '~/utils/trpc';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';

export function ModelDiscussionDetail({
  commentId,
  modelId,
}: {
  commentId: number;
  modelId?: number;
}) {
  const { data, isLoading } = trpc.commentv2.getSingle.useQuery({ id: commentId });

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
              <ModelDiscussionContextMenu />
            </Group>
            <RenderHtml html={data.content} sx={(theme) => ({ fontSize: theme.fontSizes.sm })} />
            <CommentReactions comment={data} />
          </Stack>
        </CommentProvider>
      ) : (
        <NotFound />
      )}
    </div>
  );
}
