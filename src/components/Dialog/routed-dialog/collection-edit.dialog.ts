import type CollectionEditModal from '~/components/Collections/CollectionEditModal';
import { routedDialog } from '~/components/Dialog/routed-dialog/utils';

export const collectionEditDialog = routedDialog<typeof CollectionEditModal>({
  resolve: (query, { collectionId }) => ({
    query: { ...query, collectionId },
  }),
});
