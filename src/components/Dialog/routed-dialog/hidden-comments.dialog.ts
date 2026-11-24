import type HiddenCommentsModal from '~/components/Model/ModelDiscussion/HiddenCommentsModal';
import { routedDialog } from '~/components/Dialog/routed-dialog/utils';

export const hiddenCommentsDialog = routedDialog<typeof HiddenCommentsModal>({
  resolve: (query, { modelId }) => ({ query: { ...query, modelId } }),
});
