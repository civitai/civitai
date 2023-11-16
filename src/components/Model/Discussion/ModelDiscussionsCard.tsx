import { InfiniteCommentV2Model } from '~/server/controllers/commentv2.controller';
import { Badge, Button, Card, Group, Text, Divider } from '@mantine/core';
import { IconMessageCircle2 } from '@tabler/icons-react';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { abbreviateNumber } from '~/utils/number-helpers';
import { useModelDiscussionInfiniteContext } from '~/components/Model/Discussion/ModelDiscussionsInfinite';
import { ModelDiscussionContextMenu } from '~/components/Model/Discussion/ModelDiscussionContextMenu';

import {
  CommentProvider,
  useCommentV2Context,
} from '~/components/CommentsV2/Comment/CommentProvider';
import { CommentReactions } from '~/components/CommentsV2/Comment/CommentReactions';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogProvider';

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
            onClick={() =>
              triggerRoutedDialog({ name: 'commentThread', state: { commentId: comment.id } })
            }
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
