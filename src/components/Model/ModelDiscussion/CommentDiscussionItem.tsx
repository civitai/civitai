import { Badge, Button, Card, Group, Text, ThemeIcon, Tooltip } from '@mantine/core';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import { IconExclamationCircle, IconLock, IconMessageCircle2 } from '@tabler/icons-react';

import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { CommentDiscussionMenu } from '~/components/Model/ModelDiscussion/CommentDiscussionMenu';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ReactionDetails } from '~/server/selectors/reaction.selector';
import type { CommentGetAllItem } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export function CommentDiscussionItem({ data: comment, modelUserId }: Props) {
  const currentUser = useCurrentUser();

  const { data: reactions = [] } = trpc.comment.getReactions.useQuery(
    { commentId: comment.id },
    { initialData: comment.reactions, staleTime: Infinity, refetchOnWindowFocus: false }
  );
  const { data: commentCount = 0 } = trpc.comment.getCommentsCount.useQuery(
    { id: comment.id },
    { initialData: comment._count.comments, staleTime: Infinity, refetchOnWindowFocus: false }
  );

  const queryUtils = trpc.useUtils();

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
            profilePicture: null,
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
      <Group align="flex-start" justify="space-between" wrap="nowrap" mb="xs">
        <UserAvatar
          user={comment.user}
          subText={<DaysFromNow date={comment.createdAt} />}
          subTextForce
          avatarSize="md"
          badge={
            modelUserId != null && comment.user.id === modelUserId ? (
              <Badge size="xs" color="violet">
                OP
              </Badge>
            ) : null
          }
          withUsername
          linkToProfile
        />
        <CommentDiscussionMenu comment={comment} hideLockOption modelUserId={modelUserId} />
      </Group>

      <ContentClamp maxHeight={100}>
        <RenderHtml html={comment.content} className="text-sm" withMentions withProfanityFilter />
      </ContentClamp>

      <Group mt="sm" align="flex-start" justify="space-between" wrap="nowrap">
        <ReactionPicker
          reactions={reactions}
          onSelect={handleReactionClick}
          disabled={toggleReactionMutation.isLoading}
        />
        <Group gap={4} wrap="nowrap">
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
            radius="xl"
            variant="subtle"
            onClick={() =>
              triggerRoutedDialog({ name: 'commentThread', state: { commentId: comment.id } })
            }
            size="compact-xs"
          >
            <Group gap={2} wrap="nowrap">
              <IconMessageCircle2 size={14} />
              <Text>{abbreviateNumber(commentCount)}</Text>
            </Group>
          </Button>
        </Group>
      </Group>
    </Card>
  );
}

type Props = { data: CommentGetAllItem; modelUserId?: number };
