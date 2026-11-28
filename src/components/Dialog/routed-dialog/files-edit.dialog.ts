import type FilesEditModal from '~/components/Resource/FilesEditModal';
import { routedDialog } from '~/components/Dialog/routed-dialog/utils';

export const filesEditDialog = routedDialog<typeof FilesEditModal>({
  resolve: (query, { modelVersionId }) => ({
    query: { ...query, modelVersionId },
  }),
});
