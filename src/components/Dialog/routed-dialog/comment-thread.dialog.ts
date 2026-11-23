import type CommentThreadModal from '~/components/Model/Discussion/CommentThreadModal';
import { routedDialog } from '~/components/Dialog/routed-dialog/utils';

export const commentThreadDialog = routedDialog<typeof CommentThreadModal>({
  resolve: (query, { commentId, highlight }) => ({
    query: { ...query, commentId, highlight },
  }),
});
