import { InfiniteCommentV2Model } from '~/server/controllers/commentv2.controller';
import {
  AspectRatio,
  createStyles,
  Badge,
  Button,
  Card,
  Group,
  ThemeIcon,
  Tooltip,
  Text,
  Divider,
} from '@mantine/core';
import { useMemo } from 'react';
import { InView } from 'react-intersection-observer';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { Reactions } from '~/components/Reaction/Reactions';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReviewReactions } from '@prisma/client';
import { IconExclamationCircle, IconLock, IconMessageCircle2 } from '@tabler/icons-react';

import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { CommentDiscussionMenu } from '~/components/Model/ModelDiscussion/CommentDiscussionMenu';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { openRoutedContext } from '~/providers/RoutedContextProvider';
import { ReactionDetails } from '~/server/selectors/reaction.selector';
import { CommentGetAllItem } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { useModelDiscussionInfiniteContext } from '~/components/Model/Discussion/ModelDiscussionsInfinite';
import { ModelDiscussionContextMenu } from '~/components/Model/Discussion/ModelDiscussionContextMenu';
import { Comment } from '~/components/CommentsV2';
import {
  CommentProvider,
  useCommentV2Context,
} from '~/components/CommentsV2/Comment/CommentProvider';
import { CommentReactions } from '~/components/CommentsV2/Comment/CommentReactions';

export function ModelDiscussionsCard({ data: comment }: { data: InfiniteCommentV2Model }) {
  return (
    <CommentProvider comment={comment}>
      <ModelDiscussionsContent />
    </CommentProvider>
  );
}

export function ModelDiscussionsContent() {
  const { modelUserId } = useModelDiscussionInfiniteContext();
  const { comment } = useCommentV2Context();

  // TODO - on card click, optimistically update comment

  return (
    <Card radius="md" withBorder shadow="sm" p="md" style={{ overflow: 'visible' }}>
      <Group align="flex-start" position="apart" noWrap>
        <UserAvatar
          user={comment.user}
          subText={<DaysFromNow date={comment.createdAt} />}
          subTextForce
          badge={
            comment.user.id === modelUserId ? (
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
      <ContentClamp maxHeight={90}>
        <RenderHtml html={comment.content} sx={(theme) => ({ fontSize: theme.fontSizes.sm })} />
      </ContentClamp>
      <Card.Section pt="xs">
        <Divider />
        <Group spacing={4} position="apart" p="xs">
          <CommentReactions comment={comment} />
          <Button
            size="xs"
            radius="xl"
            variant="subtle"
            onClick={() => openRoutedContext('commentThread', { commentId: comment.id })}
            compact
          >
            <Group spacing={4} noWrap>
              <IconMessageCircle2 size={14} />
              {comment.childThread && (
                <Text>{abbreviateNumber(comment.childThread._count.comments)}</Text>
              )}
            </Group>
          </Button>
        </Group>
      </Card.Section>
    </Card>
  );
}
