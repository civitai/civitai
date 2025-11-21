import dynamic from 'next/dynamic';
import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';

const CommentThreadModal = dynamic(
  () => import('~/components/Model/Discussion/CommentThreadModal'),
  { ssr: false }
);

const commentThreadDialog = routedDialogDictionary.addItem('commentThread', {
  component: CommentThreadModal,
  resolve: (query, { commentId, highlight }) => ({
    query: { ...query, commentId, highlight },
  }),
});

export type CommentThreadDialog = typeof commentThreadDialog;
