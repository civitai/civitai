import { Button, Loader, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import {
  IconArrowBackUp,
  IconArrowRight,
  IconCaretDownFilled,
  IconExclamationCircle,
  IconLock,
  IconPinned,
  IconTrash,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import {
  HiddenCommentAvatar,
  HiddenCommentLabel,
  HideAgainButton,
  useHiddenCommentReveal,
} from '~/components/CommentsV3/HiddenComment';
import { CommentBadge } from '~/components/CommentsV3/CommentBadge';
import { useScrollToHighlightedComment } from '~/components/CommentsV3/useScrollToHighlightedComment';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { CommentTimeChip } from '~/components/Music/TimedComments/TimedCommentChips';
import { Reactions } from '~/components/Reaction/Reactions';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';
import { CommentEditor } from './CommentComposer';
import { CommentMenu, useCommentAbilities } from './CommentMenu';
import { useCommentReactions } from './useCommentReactions';
import { useCommentSection } from './CommentSectionContext';
import type { CommentV3Comment } from './types';
import classes from '~/components/CommentsV3/CommentItem.module.css';

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
  repliesElsewhere,
}: {
  comment: CommentV3Comment;
  level: number;
  /** A lock on this comment's topic or anything above it in the view. */
  lockedAbove: boolean;
  /** The root of a focused view pages its replies in place instead of opening another view. */
  pageRepliesInPlace?: boolean;
  /** The view shows this comment's replies and reply box itself, as a thread dialog's root. */
  repliesElsewhere?: boolean;
}) {
  const section = useCommentSection();
  const { entityType, badges, highlightedId, seededChildren, focus } = section;
  const currentUser = useCurrentUser();
  const { concealed, reveal, conceal } = useHiddenCommentReveal(comment.hidden);
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);

  // Null on a deleted comment, which stays only as a placeholder for its replies.
  const author = comment.user;
  const can = useCommentAbilities(comment, lockedAbove);
  const isMod = can.isMod;
  const badge = author && badges.find((b) => b.userId === author.id);

  const createdReplies = section.created[comment.id] ?? [];
  const replyCount = comment.replyCount + createdReplies.length;
  const maxDepth = constants.comments.getMaxDepth({ entityType });
  const seeded = seededChildren[comment.id];
  const [expanded, setExpanded] = useState(!repliesElsewhere && !!seeded && level < maxDepth);
  // Past the display depth a thread opens as its own view instead of indenting further.
  const opensOwnView = level >= maxDepth && !expanded;
  const toggleReplies = () => (opensOwnView ? focus(comment.id) : setExpanded((x) => !x));

  const isHighlighted = highlightedId === comment.id;
  useScrollToHighlightedComment(isHighlighted, comment.id);

  const { metrics, reactions: myReactions } = useCommentReactions(comment);

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
        <UserAvatar user={author} size="sm" linkToProfile withShowcaseHat />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-4">
          {!author ? (
            <Text size="sm" c="dimmed" fs="italic">
              This comment was deleted
            </Text>
          ) : concealed ? (
            <HiddenCommentLabel onShow={reveal} />
          ) : (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <UserAvatar
                user={author}
                size="md"
                linkToProfile
                includeAvatar={false}
                withUsername
                badge={badge ? <CommentBadge {...badge} /> : null}
              />
              {comment.timestampSec != null && (
                <CommentTimeChip timestampSec={comment.timestampSec} />
              )}
              <Text c="dimmed" size="xs" mt={2}>
                <DaysFromNow date={comment.createdAt} />
              </Text>
              {comment.pinnedAt && (
                <ThemeIcon size="sm" color="orange">
                  <IconPinned size={16} stroke={2} />
                </ThemeIcon>
              )}
              {comment.locked && (
                <Tooltip label="Replies locked">
                  <ThemeIcon size="sm" color="yellow">
                    <IconLock size={14} />
                  </ThemeIcon>
                </Tooltip>
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
            <div className="shrink-0">
              <CommentMenu
                comment={comment}
                lockedAbove={lockedAbove}
                onEdit={() => setEditing(true)}
              />
            </div>
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
                {can.reply && !repliesElsewhere && (
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
            lockedAbove={lockedAbove || comment.locked}
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
        {replyCount > 0 && !expanded && !repliesElsewhere && (
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
      {replyCount > 0 && !repliesElsewhere && (
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
