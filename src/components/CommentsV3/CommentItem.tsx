import { Button, Loader, Menu, Text, ThemeIcon, Tooltip, UnstyledButton } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import {
  IconArrowBackUp,
  IconArrowRight,
  IconBell,
  IconBellOff,
  IconCaretDownFilled,
  IconDotsVertical,
  IconEdit,
  IconExclamationCircle,
  IconEye,
  IconEyeOff,
  IconFlag,
  IconId,
  IconLink,
  IconPinned,
  IconPinnedOff,
  IconShieldOff,
  IconTrash,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import {
  HiddenCommentAvatar,
  HiddenCommentLabel,
  HideAgainButton,
  useHiddenCommentReveal,
} from '~/components/CommentsV2/Comment/HiddenComment';
import { CommentBadge } from '~/components/CommentsV2/Comment/CommentBadge';
import { useScrollToHighlightedComment } from '~/components/CommentsV2/Comment/useScrollToHighlightedComment';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { BlockUserButton } from '~/components/HideUserButton/BlockUserButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import type { ReactionMetrics } from '~/components/Reaction/Reactions';
import { Reactions } from '~/components/Reaction/Reactions';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { isViewer } from '~/utils/is-viewer';
import { trpc } from '~/utils/trpc';
import { CommentEditor } from './CommentComposer';
import { useCommentSection } from './CommentSectionContext';
import type { CommentV3Comment } from './types';
import { useCommentMutations } from './useCommentMutations';
import classes from '~/components/CommentsV2/Comment/Comment.module.css';

/** An editor's trailing empty paragraph, which would render as a blank line under the text. */
const stripTrailingEmpty = (html: string) => html.replace(/(<p><\/p>)+$/, '');

/**
 * One comment: author, body, reactions, menu, reply box, and its replies. `level` is its depth in
 * the view (1 for a root), which decides whether its replies open in place or as their own view.
 */
export function CommentItem({
  comment,
  level,
  lockedAbove,
  pageRepliesInPlace,
}: {
  comment: CommentV3Comment;
  level: number;
  /** A lock on this comment's topic or anything above it in the view. */
  lockedAbove: boolean;
  /** The root of a focused view pages its replies in place instead of opening another view. */
  pageRepliesInPlace?: boolean;
}) {
  const section = useCommentSection();
  const {
    entityType,
    ownerId,
    badges,
    highlightedId,
    isMuted,
    forceLocked,
    seededChildren,
    focus,
  } = section;
  const currentUser = useCurrentUser();
  const mutations = useCommentMutations();
  const clipboard = useClipboard();
  const { concealed, reveal, conceal } = useHiddenCommentReveal(comment.hidden);
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [menuOpened, setMenuOpened] = useState(false);

  // Null on a deleted comment, which stays only as a placeholder for its replies.
  const author = comment.user;
  const isOwner = isViewer(currentUser, author?.id);
  const isMod = !!currentUser?.isModerator;
  const isResourceOwner = isViewer(currentUser, ownerId);
  const can = {
    delete: isOwner || isMod,
    edit: (isOwner || isMod) && ((!lockedAbove && !isMuted) || isMod),
    reply: !!currentUser && !lockedAbove && !isMuted && !forceLocked && !comment.hidden,
    hide: isResourceOwner || isMod,
    pin: isResourceOwner || isMod,
    report: !isOwner,
  };
  const badge = author && badges.find((b) => b.userId === author.id);

  // Fetched only while the menu is open: one query per comment on every page would cost more.
  const { data: threadMute } = trpc.commentv2.getThreadMuted.useQuery(
    { commentId: comment.id },
    { enabled: menuOpened && !!currentUser }
  );

  const createdReplies = section.created[comment.id] ?? [];
  const replyCount = comment.replyCount + createdReplies.length;
  const maxDepth = constants.comments.getMaxDepth({ entityType });
  const seeded = seededChildren[comment.id];
  const [expanded, setExpanded] = useState(!!seeded && level < maxDepth);
  // Past the display depth a thread opens as its own view instead of indenting further.
  const opensOwnView = level >= maxDepth && !expanded;
  const toggleReplies = () => (opensOwnView ? focus(comment.id) : setExpanded((x) => !x));

  const isHighlighted = highlightedId === comment.id;
  useScrollToHighlightedComment(isHighlighted, comment.id);

  const metrics = useMemo(
    (): ReactionMetrics => ({
      likeCount: comment.reactions.Like,
      dislikeCount: comment.reactions.Dislike,
      heartCount: comment.reactions.Heart,
      laughCount: comment.reactions.Laugh,
      cryCount: comment.reactions.Cry,
    }),
    [comment.reactions]
  );
  const myReactions = useMemo(
    () =>
      currentUser
        ? comment.myReactions.map((reaction) => ({ userId: currentUser.id, reaction }))
        : [],
    [comment.myReactions, currentUser]
  );

  const confirmDelete = () =>
    openConfirmModal({
      title: 'Delete comment',
      children: (
        <Text size="sm">
          Are you sure you want to delete this comment? This action is destructive and cannot be
          reverted.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Delete comment', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => void mutations.delete(comment).catch(() => null),
    });
  const confirmTos = () =>
    openConfirmModal({
      title: 'Remove as ToS violation',
      children: (
        <Text size="sm">
          This flags the comment as a Terms of Service violation, actions any matching reports and
          notifies the author. Are you sure?
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Remove as ToS violation', cancel: 'Cancel' },
      confirmProps: { color: 'red', loading: mutations.settingTos },
      closeOnConfirm: false,
      onConfirm: () =>
        mutations
          .removeAsTos(comment)
          .catch(() => null)
          .finally(() => closeAllModals()),
    });

  if (section.removed.has(comment.id)) return null;

  return (
    <div
      id={`comment-${comment.id}`}
      className={clsx('relative flex items-start gap-3', {
        [classes.highlightedComment]: isHighlighted,
      })}
    >
      {!author ? (
        <div className="flex size-[26px] shrink-0 items-center justify-center">
          <IconTrash size={16} className="text-gray-6 dark:text-dark-2" />
        </div>
      ) : concealed ? (
        <HiddenCommentAvatar size={26} />
      ) : (
        <UserAvatar user={author} size="sm" linkToProfile />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {!author ? (
            <Text size="sm" c="dimmed" fs="italic">
              This comment was deleted
            </Text>
          ) : concealed ? (
            <HiddenCommentLabel onShow={reveal} />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <UserAvatar
                user={author}
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
              {isMod && comment.tosViolation && (
                <Tooltip label="Has TOS Violation">
                  <ThemeIcon color="orange" size="xs">
                    <IconExclamationCircle />
                  </ThemeIcon>
                </Tooltip>
              )}
            </div>
          )}

          {author && (
            <Menu position="bottom-end" withinPortal opened={menuOpened} onChange={setMenuOpened}>
              <Menu.Target>
                <LegacyActionIcon size="xs" variant="subtle" aria-label="Comment options">
                  <IconDotsVertical size={14} />
                </LegacyActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {can.delete && (
                  <Menu.Item
                    leftSection={<IconTrash size={14} stroke={1.5} />}
                    color="red"
                    onClick={confirmDelete}
                  >
                    Delete comment
                  </Menu.Item>
                )}
                {can.edit && (
                  <Menu.Item
                    leftSection={<IconEdit size={14} stroke={1.5} />}
                    onClick={() => setEditing(true)}
                  >
                    Edit comment
                  </Menu.Item>
                )}
                {can.hide && (
                  <Menu.Item
                    leftSection={
                      comment.hidden ? (
                        <IconEye size={14} stroke={1.5} />
                      ) : (
                        <IconEyeOff size={14} stroke={1.5} />
                      )
                    }
                    onClick={() => void mutations.toggleHide(comment).catch(() => null)}
                  >
                    {comment.hidden ? 'Unhide comment' : 'Hide comment'}
                  </Menu.Item>
                )}
                {can.pin && !comment.hidden && (
                  <Menu.Item
                    leftSection={
                      comment.pinnedAt ? (
                        <IconPinnedOff size={14} stroke={1.5} />
                      ) : (
                        <IconPinned size={14} stroke={1.5} />
                      )
                    }
                    onClick={() => void mutations.togglePin(comment).catch(() => null)}
                  >
                    {comment.pinnedAt ? 'Unpin comment' : 'Pin comment'}
                  </Menu.Item>
                )}
                <HideUserButton as="menu-item" userId={author.id} />
                <BlockUserButton userId={author.id} as="menu-item" />
                {can.report && (
                  <LoginRedirect reason="report-model">
                    <Menu.Item
                      leftSection={<IconFlag size={14} stroke={1.5} />}
                      onClick={() =>
                        openReportModal({
                          // Reports on a CommentV3-write surface are filed against CommentV3.
                          entityType: constants.comments.v3WriteSurfaces.includes(entityType)
                            ? ReportEntity.CommentV3
                            : ReportEntity.CommentV2,
                          entityId: comment.id,
                        })
                      }
                    >
                      Report
                    </Menu.Item>
                  </LoginRedirect>
                )}
                {currentUser && (
                  <Menu.Item
                    leftSection={
                      threadMute?.muted ? (
                        <IconBell size={14} stroke={1.5} />
                      ) : (
                        <IconBellOff size={14} stroke={1.5} />
                      )
                    }
                    // The toggle flips from the stored state, so it waits for that state to load.
                    disabled={
                      !threadMute ||
                      threadMute.viaAncestor ||
                      mutations.togglingMute ||
                      !threadMute.canMute
                    }
                    onClick={() => void mutations.toggleMute(comment).catch(() => null)}
                  >
                    {threadMute?.viaAncestor
                      ? 'Muted with the thread above'
                      : threadMute && !threadMute.canMute
                      ? 'No replies to mute yet'
                      : threadMute?.muted
                      ? 'Unmute this thread'
                      : 'Mute this thread'}
                  </Menu.Item>
                )}
                <Menu.Item
                  leftSection={<IconLink size={14} stroke={1.5} />}
                  onClick={() => {
                    // Through the permalink, so the copy carries none of this page's link parameters.
                    clipboard.copy(`${window.location.origin}/comments/${comment.id}`);
                    showSuccessNotification({ message: 'Comment link copied to clipboard' });
                  }}
                >
                  Copy link
                </Menu.Item>
                {isMod && (
                  <Menu.Item
                    leftSection={<IconId size={14} stroke={1.5} />}
                    onClick={() => {
                      clipboard.copy(String(comment.id));
                      showSuccessNotification({ message: 'Comment ID copied to clipboard' });
                    }}
                  >
                    Copy comment ID
                  </Menu.Item>
                )}
                {isMod && !comment.tosViolation && (
                  <Menu.Item
                    color="red"
                    leftSection={<IconShieldOff size={14} stroke={1.5} />}
                    onClick={confirmTos}
                  >
                    Remove as ToS violation
                  </Menu.Item>
                )}
              </Menu.Dropdown>
            </Menu>
          )}
        </div>

        {editing ? (
          <CommentEditor editing={comment} autoFocus onDone={() => setEditing(false)} />
        ) : (
          author &&
          !concealed && (
            <>
              <LineClamp className="my-[5px] text-sm" lineClamp={3} variant="block">
                <RenderHtml
                  html={stripTrailingEmpty(comment.content)}
                  allowCustomStyles={false}
                  withMentions
                  withProfanityFilter
                  allowStickers
                />
              </LineClamp>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <Reactions
                  reactions={myReactions}
                  entityId={comment.id}
                  entityType="comment"
                  metrics={metrics}
                />
                {comment.hidden && <HideAgainButton onClick={conceal} />}
                {can.reply && (
                  <Button
                    variant="subtle"
                    radius="xl"
                    onClick={() => setReplying(true)}
                    size="compact-xs"
                    color="gray"
                    leftSection={<IconArrowBackUp size={14} />}
                  >
                    Reply
                  </Button>
                )}
              </div>
            </>
          )
        )}

        {expanded && (
          <CommentReplies
            parent={comment}
            level={level + 1}
            lockedAbove={lockedAbove}
            pageInPlace={pageRepliesInPlace}
          />
        )}
        {replying && (
          <div className={clsx('flex items-start gap-3 pt-3', classes.replyInset)}>
            {currentUser && <UserAvatar user={currentUser} size="sm" />}
            <CommentEditor
              parent={comment}
              autoFocus
              onDone={() => {
                setReplying(false);
                setExpanded(level < maxDepth);
              }}
            />
          </div>
        )}
        {replyCount > 0 && !expanded && (
          <Button
            className="mt-2.5 self-start"
            variant="subtle"
            radius="xl"
            color="blue"
            size="sm"
            onClick={toggleReplies}
            rightSection={
              opensOwnView ? <IconArrowRight size={16} /> : <IconCaretDownFilled size={16} />
            }
          >
            {opensOwnView
              ? `View ${replyCount} ${replyCount > 1 ? 'replies' : 'reply'}`
              : `Show ${replyCount} More`}
          </Button>
        )}
      </div>
      {replyCount > 0 && (
        <UnstyledButton onClick={toggleReplies} className={classes.repliesIndicator} />
      )}
    </div>
  );
}

/**
 * A comment's replies. Uses what the page opened up front when there is any, otherwise fetches the
 * first page. A thread with more than fits opens as its own view rather than paging in place, so
 * an indented block never grows without end; in that view (`pageInPlace`) it pages in place.
 */
export function CommentReplies({
  parent,
  level,
  lockedAbove,
  pageInPlace,
}: {
  parent: CommentV3Comment;
  level: number;
  lockedAbove: boolean;
  pageInPlace?: boolean;
}) {
  const { seededChildren, byId, sort, created, focus } = useCommentSection();
  const seeded = seededChildren[parent.id];
  // A seeded list fetches only when the reader asks for more; an unseeded one fetches its first page.
  const [wantMore, setWantMore] = useState(false);
  const fetched = trpc.commentv3.getReplies.useInfiniteQuery(
    { parentId: parent.id, sort },
    {
      enabled: !seeded || wantMore,
      initialCursor: seeded?.nextCursor ?? undefined,
      getNextPageParam: (page) => page.children[parent.id]?.nextCursor ?? undefined,
    }
  );
  const fetchedPages = fetched.data?.pages;

  const items = useMemo(() => {
    const pages = !seeded || wantMore ? fetchedPages ?? [] : [];
    const seen = new Set<number>();
    const list: CommentV3Comment[] = [];
    const push = (c?: CommentV3Comment) => {
      if (c && !seen.has(c.id)) {
        seen.add(c.id);
        list.push(c);
      }
    };
    for (const id of seeded?.ids ?? []) push(byId.get(id));
    for (const page of pages) for (const c of page.comments) push(c);
    for (const c of created[parent.id] ?? []) push(c);
    return list;
  }, [seeded, wantMore, byId, fetchedPages, created, parent.id]);

  const locked = lockedAbove || (fetched.data?.pages[0]?.locked ?? false);
  const hasMore = seeded && !wantMore ? !!seeded.nextCursor : !!fetched.hasNextPage;
  const showMore = () => {
    if (!pageInPlace) return focus(parent.id);
    if (!wantMore) return setWantMore(true);
    void fetched.fetchNextPage();
  };

  if (!seeded && fetched.isLoading)
    return (
      <div className="mt-4 flex justify-center">
        <Loader type="bars" size="sm" />
      </div>
    );

  return (
    <div className={clsx('mt-4 flex flex-col gap-4', classes.replyInset)}>
      {items.map((reply) => (
        <CommentItem key={reply.id} comment={reply} level={level} lockedAbove={locked} />
      ))}
      {hasMore && (
        <Button
          className="self-start"
          variant="subtle"
          radius="xl"
          color="blue"
          size="sm"
          loading={fetched.isFetching}
          onClick={showMore}
          rightSection={
            pageInPlace ? <IconCaretDownFilled size={16} /> : <IconArrowRight size={16} />
          }
        >
          {pageInPlace ? 'Show more replies' : `View all ${parent.replyCount} replies`}
        </Button>
      )}
    </div>
  );
}
