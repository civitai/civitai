import { Badge, Modal, Group, CloseButton, Alert, Center, Loader, Stack } from '@mantine/core';
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

export default createRoutedContext({
  schema: z.object({
    commentId: z.number(),
    highlight: z.number().optional(),
  }),
  Element: ({ context, props: { commentId, highlight } }) => {
    const queryUtils = trpc.useContext();
    const currentUser = useCurrentUser();

    const { data: comment, isLoading: commentLoading } = trpc.comment.getById.useQuery({
      id: commentId,
    });
    const { data: comments = [], isLoading: commentsLoading } =
      trpc.comment.getCommentsById.useQuery({
        id: commentId,
      });
    const { data: reactions = [] } = trpc.comment.getReactions.useQuery(
      { commentId },
      { enabled: !!comment, initialData: comment?.reactions }
    );
    const { data: model } = trpc.model.getById.useQuery(
      { id: comment?.modelId ?? -1 },
      { enabled: !!comment }
    );

    const toggleReactionMutation = trpc.comment.toggleReaction.useMutation({
      async onMutate({ id, reaction }) {
        await queryUtils.comment.getReactions.cancel({ commentId: id });

        const previousReactions = queryUtils.comment.getReactions.getData({ commentId: id }) ?? [];
        const latestReaction =
          previousReactions.length > 0
            ? previousReactions[previousReactions.length - 1]
            : { id: 0 };

        if (currentUser) {
          const newReaction: ReactionDetails = {
            id: latestReaction.id + 1,
            reaction,
            user: {
              id: currentUser.id,
              deletedAt: null,
              username: currentUser.username ?? '',
              image: currentUser.image ?? '',
            },
          };
          const reacted = previousReactions.find(
            (r) => r.reaction === reaction && r.user.id === currentUser.id
          );
          queryUtils.comment.getReactions.setData({ commentId: id }, (old = []) =>
            reacted
              ? old.filter((oldReaction) => oldReaction.id !== reacted.id)
              : [...old, newReaction]
          );
        }

        return { previousReactions };
      },
      onError(_error, _variables, context) {
        queryUtils.comment.getReactions.setData({ commentId }, context?.previousReactions);
      },
    });

    const loading = commentLoading || commentsLoading;

    return (
      <Modal opened={context.opened} onClose={context.close} withCloseButton={false} size={800}>
        {loading ? (
          <Center p="xl" style={{ height: 300 }}>
            <Loader />
          </Center>
        ) : !comment ? (
          <Alert>Comment could not be found</Alert>
        ) : (
          <Stack>
            <Group position="apart" align="flex-start" noWrap>
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
              <Group spacing={4} noWrap>
                <CommentDiscussionMenu comment={comment} user={currentUser} />
                <CloseButton onClick={context.close} />
              </Group>
            </Group>
            {currentUser?.isModerator && comment.tosViolation && (
              <AlertWithIcon color="yellow" iconColor="yellow" icon={<IconExclamationCircle />}>
                This comment has been marked with a TOS Violation. This is only visible for
                moderators.
              </AlertWithIcon>
            )}
            <Stack spacing="xl">
              <RenderHtml html={comment.content} withMentions />
              <ReactionPicker
                reactions={reactions}
                onSelect={(reaction) => toggleReactionMutation.mutate({ id: commentId, reaction })}
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
  },
});
