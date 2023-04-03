import {
  Badge,
  Modal,
  Group,
  CloseButton,
  Alert,
  Center,
  Loader,
  Stack,
  LoadingOverlay,
  Title,
} from '@mantine/core';
import { IconExclamationCircle } from '@tabler/icons';
import { z } from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';

import { CommentSection } from '~/components/CommentSection/CommentSection';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { CommentDiscussionMenu } from '~/components/Model/ModelDiscussion/CommentDiscussionMenu';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { ReactionDetails } from '~/server/selectors/reaction.selector';
import { trpc } from '~/utils/trpc';

import { NotFound } from '~/components/AppLayout/NotFound';
import { CommentProvider } from '~/components/CommentsV2/Comment/CommentProvider';
import { CommentReactions } from '~/components/CommentsV2/Comment/CommentReactions';
import { ModelDiscussionContextMenu } from '~/components/Model/Discussion/ModelDiscussionContextMenu';
import { ModelDiscussionComments } from '~/components/Model/Discussion/ModelDiscussionComments';

export default createRoutedContext({
  schema: z.object({
    id: z.number(),
    commentId: z.number(),
    highlight: z.number().optional(),
  }),
  Element: ({ context, props: { commentId, highlight, id: modelId } }) => {
    const { data, isLoading } = trpc.commentv2.getSingle.useQuery({ id: commentId });

    return (
      <Modal opened={context.opened} onClose={context.close} withCloseButton={false} size={800}>
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
                    <CloseButton onClick={context.close} />
                  </Group>
                </Group>
                <RenderHtml
                  html={data.content}
                  sx={(theme) => ({ fontSize: theme.fontSizes.sm })}
                />
                <CommentReactions comment={data} />
              </Stack>
              <Stack spacing="xl">
                <Group position="apart">
                  <Title order={3}>{`${data.childThread?._count.comments.toLocaleString()} ${
                    data.childThread?._count.comments === 1 ? 'Comment' : 'Comments'
                  }`}</Title>
                </Group>
                <ModelDiscussionComments commentId={commentId} userId={data.user.id} />
              </Stack>
            </CommentProvider>
          ) : (
            <NotFound />
          )}
        </div>
      </Modal>
    );
  },
});
