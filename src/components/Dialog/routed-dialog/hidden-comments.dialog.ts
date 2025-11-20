import dynamic from 'next/dynamic';
import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';

const HiddenCommentsModal = dynamic(() => import('~/components/CommentsV2/HiddenCommentsModal'), {
  ssr: false,
});

const hiddenCommentsDialog = routedDialogDictionary.addItem('hiddenComments', {
  component: HiddenCommentsModal,
  resolve: (query, { entityType, entityId }) => ({
    query: { ...query, entityType, entityId },
  }),
});

export type HiddenCommentsDialog = typeof hiddenCommentsDialog;
