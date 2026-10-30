import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import produce from 'immer';
import type { CommentV2GetInfinite } from '~/types/router';

/**
 * Writes an edited comment's content into every cached `commentv2.getInfinite` thread that holds it.
 * A thread is keyed on sort, limit and reply depth as well as its entity, so the edit has to be
 * matched by procedure prefix — an exact `{ entityType, entityId }` key never hits the visible list.
 */
export function editCommentInInfiniteCaches(
  queryClient: QueryClient,
  procedureKey: QueryKey,
  { id, content }: { id: number; content: string }
) {
  queryClient.setQueriesData<InfiniteData<CommentV2GetInfinite>>(
    { queryKey: procedureKey, exact: false },
    (state) =>
      produce(state, (draft) => {
        if (!draft?.pages?.length) return;

        const edit = (comment?: { id: number; content: string } | null) => {
          if (comment?.id === id) comment.content = content;
        };

        for (const page of draft.pages) {
          if (!page) continue;
          page.comments?.forEach(edit);
          edit(page.targetComment);
          for (const thread of page.replyThreads ?? []) thread.comments.forEach(edit);
        }
      })
  );
}
