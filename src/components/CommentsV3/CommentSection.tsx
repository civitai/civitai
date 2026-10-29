import { Alert, Button, Divider, Loader, Text, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { useEffect, useRef } from 'react';
import { SortFilter } from '~/components/Filters';
import type { ThreadSort } from '~/server/common/enums';
import { CommentComposer } from './CommentComposer';
import { CommentItem } from './CommentItem';
import { CommentSectionProvider, useCommentSection } from './CommentSectionContext';
import type { CommentV3Badge, CommentV3SurfaceType } from './types';

export type CommentSectionProps = {
  entityType: CommentV3SurfaceType;
  entityId: number;
  /** The entity's owner. They get the "op" badge and may hide and pin, unless switched off below. */
  ownerId?: number;
  /** The owner gets the "op" badge. Off where another badge names who the surface presents. */
  ownerBadge?: boolean;
  /** The owner may hide and pin comments. */
  ownerModerates?: boolean;
  /** Extra badges beyond the owner's. */
  badges?: CommentV3Badge[];
  /** Opens the comment a link names (`highlight`, `commentParent*`). Off for a second section on a page. */
  deepLinks?: boolean;
  /** Render nothing once the section is locked. */
  hideWhenLocked?: boolean;
  /** Comments are shown but nobody may write. */
  forceLocked?: boolean;
  /** Replaces the default "Comments" heading; `null` drops the header row. */
  title?: React.ReactNode | null;
  /** Drops the sort control, for compact surfaces. */
  hideSort?: boolean;
  /** Editors without a border, for surfaces that frame the section themselves. */
  borderless?: boolean;
  /** Shown when there are no comments; `null` shows nothing. */
  emptyState?: React.ReactNode | null;
  /** An id on the section, for `#` links to it. */
  anchorId?: string;
};

/** The comment section any surface mounts. See `docs/plans/comments-v3-article-flip.md`. */
export function CommentSection({
  entityType,
  entityId,
  ownerId,
  ownerBadge = true,
  ownerModerates = true,
  badges = [],
  deepLinks = true,
  forceLocked,
  borderless,
  ...view
}: CommentSectionProps) {
  const allBadges: CommentV3Badge[] =
    ownerId && ownerBadge ? [{ userId: ownerId, label: 'op', color: 'violet' }, ...badges] : badges;
  return (
    // Keyed so moving to another entity (an image modal paging between images) starts clean.
    <CommentSectionProvider
      key={`${entityType}_${entityId}`}
      entityType={entityType}
      entityId={entityId}
      ownerId={ownerModerates ? ownerId : undefined}
      badges={allBadges}
      deepLinks={deepLinks}
      forceLocked={forceLocked}
      borderless={borderless}
    >
      <CommentSectionView {...view} />
    </CommentSectionProvider>
  );
}

function CommentSectionView({
  hideWhenLocked,
  title,
  hideSort,
  emptyState = (
    <Text c="dimmed" ta="center">
      No comments yet.
    </Text>
  ),
  anchorId,
}: Pick<CommentSectionProps, 'hideWhenLocked' | 'title' | 'hideSort' | 'emptyState' | 'anchorId'>) {
  const section = useCommentSection();
  const {
    rootIds,
    byId,
    created,
    isLoading,
    isError,
    retry,
    hasMore,
    isFetchingMore,
    loadMore,
    locked,
    focusedId,
  } = section;

  // Opening or leaving a thread swaps the whole list, so bring the top of the section back into
  // view; the first render is left to the highlight scroll.
  const top = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(focusedId);
  useEffect(() => {
    if (previousFocus.current === focusedId) return;
    previousFocus.current = focusedId;
    top.current?.scrollIntoView({ block: 'start' });
  }, [focusedId]);

  if (hideWhenLocked && locked) return null;

  return (
    <div className="flex flex-col gap-8" ref={top} id={anchorId}>
      {title !== null && (
        <div className="flex flex-wrap items-center justify-between gap-4">
          {title ?? <Title order={2}>Comments</Title>}
          {!hideSort && !focusedId && (
            <SortFilter
              type="threads"
              value={section.sort}
              onChange={(v) => section.setSort(v as ThreadSort)}
            />
          )}
        </div>
      )}
      {focusedId ? <FocusedThread /> : !isError && <CommentComposer />}
      {!focusedId &&
        (isError ? (
          // Not "No comments yet": a failed read says nothing about the comments or the lock.
          <Alert color="red" classNames={{ message: 'flex items-center justify-between gap-4' }}>
            <Text size="sm">Comments could not be loaded.</Text>
            <Button size="compact-sm" variant="light" color="red" onClick={retry}>
              Try again
            </Button>
          </Alert>
        ) : isLoading ? (
          <div className="flex justify-center">
            <Loader type="bars" />
          </div>
        ) : (
          // The list shares the section's column and spacing, so it needs no wrapper of its own.
          <>
            {rootIds.map((id) => {
              const comment = byId.get(id);
              return comment ? (
                <CommentItem key={id} comment={comment} level={1} lockedAbove={locked} />
              ) : null;
            })}
            {(created[0] ?? [])
              .filter((c) => !byId.has(c.id))
              .map((c) => (
                <CommentItem key={c.id} comment={c} level={1} lockedAbove={locked} />
              ))}
            {!rootIds.length && !(created[0] ?? []).length && emptyState}
            {hasMore && (
              <Divider
                label={
                  <Button variant="subtle" onClick={loadMore} loading={isFetchingMore}>
                    Load More Comments
                  </Button>
                }
                labelPosition="center"
              />
            )}
          </>
        ))}
    </div>
  );
}

/** One conversation on its own: the comment a link or "view replies" opened, and its replies. */
function FocusedThread() {
  const { focusedId, byId, focusPending, focusedThread, locked, focus } = useCommentSection();
  const comment = focusedId ? byId.get(focusedId) : undefined;
  const parentId = focusedThread?.ancestorIds.at(-1);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <Button
          variant="subtle"
          size="compact-sm"
          leftSection={<IconArrowLeft size={16} />}
          onClick={() => focus(undefined)}
        >
          View all comments
        </Button>
        {parentId && (
          <Button variant="subtle" size="compact-sm" onClick={() => focus(parentId)}>
            View parent comment
          </Button>
        )}
      </div>
      {focusPending || !comment ? (
        <div className="flex justify-center">
          <Loader type="bars" />
        </div>
      ) : (
        <CommentItem
          comment={comment}
          level={1}
          lockedAbove={locked || !!focusedThread?.locked}
          pageRepliesInPlace
        />
      )}
    </div>
  );
}
