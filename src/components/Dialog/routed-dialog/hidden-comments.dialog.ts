import dynamic from 'next/dynamic';
import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';

const HiddenCommentsModal = dynamic(
  () => import('~/components/Model/ModelDiscussion/HiddenCommentsModal'),
  { ssr: false }
);

const hiddenCommentsDialog = routedDialogDictionary.addItem('hiddenComments', {
  component: HiddenCommentsModal,
  resolve: (query, { modelId }) => ({ query: { ...query, modelId } }),
});

export type HiddenCommentsDialog = typeof hiddenCommentsDialog;
