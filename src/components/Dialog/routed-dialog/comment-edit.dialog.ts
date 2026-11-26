import type CommentEditModal from '~/components/Model/ModelDiscussion/CommentEditModal';
import { routedDialog } from '~/components/Dialog/routed-dialog/utils';

export const commentEditDialog = routedDialog<typeof CommentEditModal>({
  resolve: (query) => ({ query }),
});
