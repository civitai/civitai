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
} from '@mantine/core';
import { useMemo } from 'react';
import { InView } from 'react-intersection-observer';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { Reactions } from '~/components/Reaction/Reactions';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReviewReactions } from '@prisma/client';
import { IconExclamationCircle, IconLock, IconMessageCircle2 } from '@tabler/icons';

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
import { Comment } from '~/components/CommentsV2';

export function ModelDiscussionsCard({ data: comment }: { data: InfiniteCommentV2Model }) {
  const currentUser = useCurrentUser();
  const { modelUserId } = useModelDiscussionInfiniteContext();

  return (
    <Card radius="md" withBorder shadow="sm" p="md">
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
        {/* <Text lineClamp={3}>
          <RenderHtml
          html={comment.content}
          sx={(theme) => ({ fontSize: theme.fontSizes.sm })}
          withMentions
          />
          </Text>
          <Group spacing={4} noWrap>
          <Reactions />
        </Group> */}
      </Group>
      <Comment comment={comment} withAvatar={false} lineClamp={4} />
    </Card>
  );
}
