import { useRouter } from 'next/router';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ThreadSort } from '~/server/common/enums';
import { parseNumericString } from '~/utils/query-string-helpers';
import { trpc } from '~/utils/trpc';
import type { CommentV3Badge, CommentV3Comment, CommentV3SurfaceType } from './types';

type Children = { ids: number[]; nextCursor: string | null };

type SectionState = {
  entityType: CommentV3SurfaceType;
  entityId: number;
  ownerId?: number;
  badges: CommentV3Badge[];
  sort: ThreadSort;
  setSort: (sort: ThreadSort) => void;
  /** Every comment the section and the focused thread have loaded, by id. */
  byId: Map<number, CommentV3Comment>;
  /** Replies the server opened up front, per parent. */
  seededChildren: Record<number, Children>;
  rootIds: number[];
  isLoading: boolean;
  /** The first page could not be loaded. */
  isError: boolean;
  retry: () => void;
  hasMore: boolean;
  isFetchingMore: boolean;
  loadMore: () => void;
  /** The topic lock; a reply list adds its own subtree lock on top. */
  locked: boolean;
  isMuted: boolean;
  isReadonly: boolean;
  forceLocked: boolean;
  /** Editors draw no border: the surface frames the section. */
  borderless: boolean;
  /** The comment the section is rooted on (a deep link, or a thread opened past the display depth). */
  focusedId?: number;
  focusedThread?: { ancestorIds: number[]; locked: boolean };
  focusPending: boolean;
  focus: (commentId?: number) => void;
  highlightedId?: number;
  /** Comments written this session, per parent (0 for top level), until a fetch returns them. */
  created: Record<number, CommentV3Comment[]>;
  addCreated: (parentId: number | null, comment: CommentV3Comment) => void;
  removed: Set<number>;
  markRemoved: (id: number) => void;
};

const SectionCtx = createContext<SectionState | null>(null);

export function useCommentSection() {
  const ctx = useContext(SectionCtx);
  if (!ctx) throw new Error('useCommentSection must be used inside CommentSectionProvider');
  return ctx;
}

/**
 * The link a reader arrived on. `commentParentType=comment` with `commentParentId` (permalinks,
 * reply notifications) roots the section on that comment; `highlight` alone (owner notifications)
 * marks a comment that is shown in the list when the first page has it, and rooted on otherwise.
 */
function useLinkedFocus(enabled: boolean) {
  const router = useRouter();
  if (!enabled) return { highlightedId: undefined, parentFocus: undefined };
  const highlightedId = parseNumericString(router.query.highlight);
  const parentType = router.query.commentParentType;
  const parentId = parseNumericString(router.query.commentParentId);
  return { highlightedId, parentFocus: parentType === 'comment' ? parentId : undefined };
}

export function CommentSectionProvider({
  entityType,
  entityId,
  ownerId,
  badges = [],
  forceLocked = false,
  deepLinks = true,
  borderless = false,
  children,
}: {
  entityType: CommentV3SurfaceType;
  entityId: number;
  /** Who may hide and pin besides moderators. */
  ownerId?: number;
  badges?: CommentV3Badge[];
  forceLocked?: boolean;
  deepLinks?: boolean;
  borderless?: boolean;
  children: React.ReactNode;
}) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const [sort, setSort] = useState<ThreadSort>(ThreadSort.Oldest);
  const { highlightedId, parentFocus } = useLinkedFocus(deepLinks);

  const section = trpc.commentv3.getSection.useInfiniteQuery(
    { entityType, entityId, sort },
    { getNextPageParam: (page) => page.nextCursor ?? undefined }
  );
  const firstPage = section.data?.pages[0];
  const linkedFocus =
    parentFocus ??
    (highlightedId && firstPage && !firstPage.comments.some((c) => c.id === highlightedId)
      ? highlightedId
      : undefined);

  // A deep link decides the starting point; opening a thread from inside overrides it, and
  // arriving on a different link resets that override, as a remount would.
  const linkKey = `${entityType}_${entityId}_${parentFocus ?? ''}_${highlightedId ?? ''}`;
  const [focusState, setFocusState] = useState<{ key: string; id?: number | null }>({
    key: linkKey,
  });
  if (focusState.key !== linkKey) setFocusState({ key: linkKey });
  const focusedOverride = focusState.key === linkKey ? focusState.id : undefined;
  const wantedFocus = focusedOverride === undefined ? linkedFocus : focusedOverride ?? undefined;

  const thread = trpc.commentv3.getThread.useQuery(
    { commentId: wantedFocus ?? 0, entityType, entityId, sort },
    { enabled: !!wantedFocus, retry: false }
  );
  // A link to a comment that is gone, hidden from this viewer or on another entity shows the whole
  // section rather than an empty one.
  const focusedId = wantedFocus && !thread.isError ? wantedFocus : undefined;

  // A reply link roots on the parent, whose first page of replies may not hold the reply: root on
  // the reply itself then, where "View parent comment" leads back up.
  const highlightMissing =
    !!thread.data &&
    !!highlightedId &&
    focusedOverride === undefined &&
    thread.data.comment.id !== highlightedId &&
    !thread.data.replies.comments.some((c) => c.id === highlightedId);
  useEffect(() => {
    if (highlightMissing && highlightedId)
      setFocusState((current) => ({ ...current, id: highlightedId }));
  }, [highlightMissing, highlightedId]);

  const [created, setCreated] = useState<Record<number, CommentV3Comment[]>>({});
  const [removed, setRemoved] = useState<Set<number>>(new Set());

  const { byId, seededChildren, rootIds } = useMemo(() => {
    const byId = new Map<number, CommentV3Comment>();
    const seededChildren: Record<number, Children> = {};
    const rootIds: number[] = [];
    for (const page of section.data?.pages ?? []) {
      for (const c of page.comments) byId.set(c.id, c);
      Object.assign(seededChildren, page.children);
      for (const id of page.rootIds) if (!rootIds.includes(id)) rootIds.push(id);
    }
    if (thread.data) {
      byId.set(thread.data.comment.id, thread.data.comment);
      for (const c of thread.data.replies.comments) byId.set(c.id, c);
      Object.assign(seededChildren, thread.data.replies.children);
    }
    return { byId, seededChildren, rootIds };
  }, [section.data, thread.data]);

  const addCreated = useCallback(
    (parentId: number | null, comment: CommentV3Comment) =>
      setCreated((current) => ({
        ...current,
        [parentId ?? 0]: [...(current[parentId ?? 0] ?? []), comment],
      })),
    []
  );
  const markRemoved = useCallback(
    (id: number) => setRemoved((current) => new Set(current).add(id)),
    []
  );
  const focus = useCallback(
    (commentId?: number) => setFocusState((current) => ({ ...current, id: commentId ?? null })),
    []
  );

  const value: SectionState = {
    entityType,
    entityId,
    ownerId,
    badges,
    sort,
    setSort,
    byId,
    seededChildren,
    rootIds,
    isLoading: section.isLoading,
    isError: section.isError,
    retry: () => void section.refetch(),
    hasMore: !!section.hasNextPage,
    isFetchingMore: section.isFetchingNextPage,
    loadMore: () => {
      if (section.hasNextPage && !section.isFetchingNextPage) void section.fetchNextPage();
    },
    locked: section.data?.pages[0]?.locked ?? false,
    isMuted: currentUser?.muted ?? false,
    isReadonly: !features.canWrite,
    forceLocked,
    borderless,
    focusedId,
    focusedThread: thread.data
      ? { ancestorIds: thread.data.ancestorIds, locked: thread.data.locked }
      : undefined,
    focusPending: !!focusedId && thread.isLoading,
    focus,
    highlightedId,
    created,
    addCreated,
    removed,
    markRemoved,
  };

  return <SectionCtx.Provider value={value}>{children}</SectionCtx.Provider>;
}
