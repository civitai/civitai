import dynamic from 'next/dynamic';
import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';

const CommentEditModal = dynamic(
  () => import('~/components/Model/ModelDiscussion/CommentEditModal'),
  { ssr: false }
);

const commentEditDialog = routedDialogDictionary.addItem('commentEdit', {
  component: CommentEditModal,
  resolve: (query) => ({ query }),
});

export type CommentEditDialog = typeof commentEditDialog;
