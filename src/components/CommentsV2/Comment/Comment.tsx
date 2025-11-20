import type { GroupProps } from '@mantine/core';
import {
  Box,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import {
  IconArrowBackUp,
  IconCaretDownFilled,
  IconDotsVertical,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconFlag,
  IconPinned,
  IconPinnedOff,
  IconTrash,
} from '@tabler/icons-react';
import clsx from 'clsx';
import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import { CommentBadge } from '~/components/CommentsV2/Comment/CommentBadge';
import {
  CommentsProvider,
  useCommentsContext,
  useRootThreadContext,
} from '~/components/CommentsV2/CommentsProvider';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/server/schema/report.schema';
import { type Comment } from '~/server/services/commentsv2.service';
import { trpc } from '~/utils/trpc';
import { constants } from '../../../server/common/constants';
import { useMutateComment } from '../commentv2.utils';
import classes from './Comment.module.css';
import { CommentForm } from './CommentForm';
import { CommentProvider, useCommentV2Context } from './CommentProvider';
import { CommentReactions } from './CommentReactions';
import { CreateComment } from './CreateComment';
import { DeleteComment } from './DeleteComment';

type Store = {
  id?: number;
  setId: (id?: number) => void;
};

const useStore = create<Store>((set) => ({
  setId: (id) => set(() => ({ id })),
}));

type CommentProps = Omit<GroupProps, 'children'> & {
  comment: Comment;
  viewOnly?: boolean;
  highlight?: boolean;
  resourceOwnerId?: number;
  borderless?: boolean;
};

export function Comment({ comment, resourceOwnerId, ...groupProps }: CommentProps) {
  return (
    <CommentProvider comment={comment} resourceOwnerId={resourceOwnerId}>
      <CommentContent comment={comment} {...groupProps} />
    </CommentProvider>
  );
}

const trimmableEnds = ['<p></p>'];

export function CommentContent({
  comment,
  viewOnly,
  highlight: highlightProp,
  borderless,
  ...groupProps
}: CommentProps) {
  const currentUser = useCurrentUser();
  const { expanded, toggleExpanded, setRootThread } = useRootThreadContext();
  const { entityId, entityType, highlighted, level } = useCommentsContext();
  const { canDelete, canEdit, canReply, canHide, badge, canReport } = useCommentV2Context();

  const { data: replyCount = 0 } = trpc.commentv2.getCount.useQuery({
    entityId: comment.id,
    entityType: 'comment',
  });

  const id = useStore((state) => state.id);
  const setId = useStore((state) => state.setId);

  const { toggleHide, togglePinned } = useMutateComment();

  const editing = id === comment.id;
  const [replying, setReplying] = useState(false);

  const isHighlighted = highlighted === comment.id;

  useEffect(() => {
    if (!isHighlighted) return;
    const elem = document.getElementById(`comment-${comment.id}`);
    if (elem) elem.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
  }, [isHighlighted, comment.id]);

  const isExpanded = !viewOnly && expanded.includes(comment.id);
  const onToggleReplies = () => {
    const maxDepth = constants.comments.getMaxDepth({ entityType });

    if ((level ?? 0) >= maxDepth && !isExpanded) {
      setRootThread('comment', comment.id);
    } else {
      toggleExpanded(comment.id);
    }
  };

  for (const end of trimmableEnds) {
    if (comment.content.endsWith(end)) {
      comment.content = comment.content.slice(0, comment.content.lastIndexOf(end));
    }
  }

  return (
    <Group
      id={`comment-${comment.id}`}
      align="flex-start"
      wrap="nowrap"
      {...groupProps}
      gap="sm"
      className={clsx(groupProps.className, classes.groupWrap, {
        [classes.highlightedComment]: highlightProp || isHighlighted,
      })}
    >
      <Group gap="xs">
        {/* {replyCount > 0 && !viewOnly && !isExpanded && (
          <UnstyledButton onClick={onToggleReplies}>
            <IconArrowsMaximize size={16} />
          </UnstyledButton>
        )} */}
        <UserAvatar user={comment.user} size="sm" linkToProfile />
      </Group>

      <Stack gap={0} style={{ flex: 1 }}>
        <Group justify="space-between">
          {/* AVATAR */}
          <Group gap={8} align="center">
            <UserAvatar
              user={comment.user}
              size="md"
              linkToProfile
              includeAvatar={false}
              withUsername
              badge={badge ? <CommentBadge {...badge} /> : null}
            />
            <Text c="dimmed" size="xs" mt={2}>
              <DaysFromNow date={comment.createdAt} />
            </Text>
            {comment.pinnedAt && (
              <ThemeIcon size="sm" color="orange">
                <IconPinned size={16} stroke={2} />
              </ThemeIcon>
            )}
          </Group>

          {/* CONTROLS */}
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <LegacyActionIcon size="xs" variant="subtle">
                <IconDotsVertical size={14} />
              </LegacyActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {canDelete && (
                <>
                  <DeleteComment id={comment.id} entityId={entityId} entityType={entityType}>
                    {({ onClick }) => (
                      <Menu.Item
                        leftSection={<IconTrash size={14} stroke={1.5} />}
                        color="red"
                        onClick={onClick}
                      >
                        Delete comment
                      </Menu.Item>
                    )}
                  </DeleteComment>
                  {canEdit && (
                    <Menu.Item
                      leftSection={<IconEdit size={14} stroke={1.5} />}
                      onClick={() => setId(comment.id)}
                    >
                      Edit comment
                    </Menu.Item>
                  )}
                </>
              )}
              {canHide && (
                <Menu.Item
                  leftSection={
                    comment.hidden ? (
                      <IconEye size={14} stroke={1.5} />
                    ) : (
                      <IconEyeOff size={14} stroke={1.5} />
                    )
                  }
                  onClick={() => toggleHide({ id: comment.id, entityType, entityId })}
                >
                  {comment.hidden ? 'Unhide comment' : 'Hide comment'}
                </Menu.Item>
              )}
              {currentUser?.isModerator && !comment.hidden && (
                <Menu.Item
                  leftSection={
                    comment.pinnedAt ? (
                      <IconPinnedOff size={14} stroke={1.5} />
                    ) : (
                      <IconPinned size={14} stroke={1.5} />
                    )
                  }
                  onClick={() => togglePinned({ id: comment.id, entityType, entityId })}
                >
                  {comment.pinnedAt ? 'Unpin comment' : 'Pin comment'}
                </Menu.Item>
              )}
              {canReport && (
                <LoginRedirect reason="report-model">
                  <Menu.Item
                    leftSection={<IconFlag size={14} stroke={1.5} />}
                    onClick={() =>
                      openReportModal({
                        entityType: ReportEntity.CommentV2,
                        entityId: comment.id,
                      })
                    }
                  >
                    Report
                  </Menu.Item>
                </LoginRedirect>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>
        {/* COMMENT / EDIT COMMENT */}
        <Stack style={{ flex: 1 }} gap={4}>
          {!editing ? (
            <>
              <Box my={5}>
                <LineClamp className="text-sm" lineClamp={3} variant="block">
                  <RenderHtml
                    html={comment.content}
                    allowCustomStyles={false}
                    withMentions
                    withProfanityFilter
                  />
                </LineClamp>
              </Box>
              {/* COMMENT INTERACTION */}
              <Group gap={4}>
                <CommentReactions comment={comment} />
                {canReply && !viewOnly && (
                  <Button
                    variant="subtle"
                    radius="xl"
                    onClick={() => setReplying(true)}
                    size="compact-xs"
                    color="gray"
                  >
                    <Group gap={4}>
                      <IconArrowBackUp size={14} />
                      Reply
                    </Group>
                  </Button>
                )}
              </Group>
            </>
          ) : (
            <CommentForm comment={comment} onCancel={() => setId(undefined)} autoFocus />
          )}
        </Stack>
        {isExpanded && <CommentReplies commentId={comment.id} userId={comment.user.id} />}
        {canReply && replying && (
          <Box pt="sm">
            <CreateComment
              autoFocus
              onCancel={() => setReplying(false)}
              replyToCommentId={comment.id}
              className={classes.replyInset}
              borderless={borderless}
            />
          </Box>
        )}
        {replyCount > 0 && !viewOnly && !isExpanded && (
          <Group align="flex-start" mt="xs">
            <Button
              variant="subtle"
              radius="xl"
              color="blue"
              size="sm"
              onClick={onToggleReplies}
              rightSection={<IconCaretDownFilled size={16} />}
            >
              Show {replyCount} More
            </Button>
          </Group>
        )}
      </Stack>
      {replyCount > 0 && !viewOnly && (
        <UnstyledButton onClick={onToggleReplies} className={classes.repliesIndicator} />
      )}
    </Group>
  );
}

function CommentReplies({ commentId, userId }: { commentId: number; userId?: number }) {
  const { level, badges } = useCommentsContext();

  return (
    <Stack mt="md" className={classes.replyInset}>
      <CommentsProvider
        entityType="comment"
        entityId={commentId}
        badges={badges}
        level={(level ?? 0) + 1}
      >
        {({ data, created, isLoading, isFetching, showMore, toggleShowMore }) =>
          isLoading ? (
            <Center>
              <Loader type="bars" />
            </Center>
          ) : (
            <Stack>
              {data?.map((comment) => (
                <Comment key={comment.id} comment={comment} />
              ))}
              {showMore && (
                <Center>
                  <Button onClick={toggleShowMore} loading={isFetching} variant="subtle" size="md">
                    Load More Comments
                  </Button>
                </Center>
              )}
              {created.map((comment) => (
                <Comment key={comment.id} comment={comment} />
              ))}
            </Stack>
          )
        }
      </CommentsProvider>
    </Stack>
  );
}
