import {
  GroupProps,
  Group,
  ActionIcon,
  Menu,
  Stack,
  Text,
  Button,
  Box,
  UnstyledButton,
  Divider,
  ThemeIcon,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useCommentsContext, useRootThreadContext } from '../CommentsProvider';
import { CreateComment } from './CreateComment';
import { CommentForm } from './CommentForm';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import {
  IconDotsVertical,
  IconTrash,
  IconEdit,
  IconFlag,
  IconArrowBackUp,
  IconEye,
  IconEyeOff,
  IconArrowsMaximize,
  IconPinned,
  IconPinnedOff,
} from '@tabler/icons-react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ReportEntity } from '~/server/schema/report.schema';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { create } from 'zustand';
import React from 'react';
import { CommentReactions } from './CommentReactions';
import { DeleteComment } from './DeleteComment';
import { CommentProvider, useCommentV2Context } from './CommentProvider';
import { CommentBadge } from '~/components/CommentsV2/Comment/CommentBadge';
import { useMutateComment } from '../commentv2.utils';
import { CommentReplies } from '../CommentReplies';
import { constants } from '../../../server/common/constants';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { openReportModal } from '~/components/Dialog/dialog-registry';
import type { Comment } from '~/server/services/commentsv2.service';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import classes from './Comment.module.scss';
import clsx from 'clsx';

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

  const trimmableEnds = ['<p></p>'];
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
            <Text color="dimmed" size="xs" mt={2}>
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
              <ActionIcon size="xs" variant="subtle">
                <IconDotsVertical size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {canDelete && (
                <>
                  <DeleteComment id={comment.id} entityId={entityId} entityType={entityType}>
                    {({ onClick }) => (
                      <Menu.Item
                        icon={<IconTrash size={14} stroke={1.5} />}
                        color="red"
                        onClick={onClick}
                      >
                        Delete comment
                      </Menu.Item>
                    )}
                  </DeleteComment>
                  {canEdit && (
                    <Menu.Item
                      icon={<IconEdit size={14} stroke={1.5} />}
                      onClick={() => setId(comment.id)}
                    >
                      Edit comment
                    </Menu.Item>
                  )}
                </>
              )}
              {canHide && (
                <Menu.Item
                  icon={
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
              {currentUser?.isModerator && (
                <Menu.Item
                  icon={
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
                    icon={<IconFlag size={14} stroke={1.5} />}
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
                <LineClamp lineClamp={3}>
                  <RenderHtml
                    html={comment.content}
                    className="text-sm"
                    allowCustomStyles={false}
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
          <Divider
            label={
              <Group gap="xs" align="center">
                <Text variant="link" sx={{ cursor: 'pointer' }} onClick={onToggleReplies}>
                  Show {replyCount} More
                </Text>
              </Group>
            }
            labelPosition="center"
            variant="dashed"
          />
        )}
      </Stack>
      {replyCount > 0 && !viewOnly && (
        <UnstyledButton onClick={onToggleReplies} className={classes.repliesIndicator} />
      )}
    </Group>
  );
}
