import { Badge, Button, Card, Group, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { ReviewReactions } from '@prisma/client';
import { IconExclamationCircle, IconLock, IconMessageCircle2 } from '@tabler/icons';

import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { CommentDiscussionMenu } from '~/components/Model/ModelDiscussion/CommentDiscussionMenu';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openRoutedContext } from '~/providers/RoutedContextProvider';
import { ReactionDetails } from '~/server/selectors/reaction.selector';
import { CommentGetAllItem } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export function CommentDiscussionItem({ comment }: Props) {
  const currentUser = useCurrentUser();

  const { data: reactions = [] } = trpc.comment.getReactions.useQuery(
    { commentId: comment.id },
    { initialData: comment.reactions }
  );
  const { data: commentCount = 0 } = trpc.comment.getCommentsCount.useQuery(
    { id: comment.id },
    { initialData: comment._count.comments }
  );
  const { data: model } = trpc.model.getById.useQuery({ id: comment.modelId });

  const queryUtils = trpc.useContext();

  const toggleReactionMutation = trpc.comment.toggleReaction.useMutation({
    async onMutate({ id, reaction }) {
      await queryUtils.comment.getReactions.cancel({ commentId: id });

      const previousReactions = queryUtils.comment.getReactions.getData({ commentId: id }) ?? [];
      const latestReaction =
        previousReactions.length > 0 ? previousReactions[previousReactions.length - 1] : { id: 0 };

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
    onError(_error, variables, context) {
      queryUtils.comment.getReactions.setData(
        { commentId: variables.id },
        context?.previousReactions
      );
    },
  });
  const handleReactionClick = (reaction: ReviewReactions) => {
    toggleReactionMutation.mutate({ id: comment.id, reaction });
  };

  return (
    <Card radius="md" p="md" withBorder>
      <Group align="flex-start" position="apart" noWrap>
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
          withUsername
          linkToProfile
        />
        <CommentDiscussionMenu comment={comment} user={currentUser} hideLockOption />
      </Group>

      <ContentClamp maxHeight={100}>
        <RenderHtml
          html={comment.content}
          sx={(theme) => ({ fontSize: theme.fontSizes.sm })}
          withMentions
        />
      </ContentClamp>

      <Group mt="sm" align="flex-start" position="apart" noWrap>
        <ReactionPicker
          reactions={reactions}
          onSelect={handleReactionClick}
          disabled={toggleReactionMutation.isLoading}
        />
        <Group spacing={4} noWrap>
          {currentUser?.isModerator && comment.tosViolation && (
            <Tooltip label="Has TOS Violation">
              <ThemeIcon color="orange" size="xs">
                <IconExclamationCircle />
              </ThemeIcon>
            </Tooltip>
          )}
          {comment.locked && (
            <ThemeIcon color="yellow" size="xs">
              <IconLock />
            </ThemeIcon>
          )}
          <Button
            size="xs"
            radius="xl"
            variant="subtle"
            onClick={() => openRoutedContext('commentThread', { commentId: comment.id })}
            compact
          >
            <Group spacing={2} noWrap>
              <IconMessageCircle2 size={14} />
              <Text>{abbreviateNumber(commentCount)}</Text>
            </Group>
          </Button>
        </Group>
      </Group>
    </Card>
  );
}

type Props = { comment: CommentGetAllItem };
