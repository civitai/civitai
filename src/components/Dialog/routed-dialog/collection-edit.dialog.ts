import dynamic from 'next/dynamic';
import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';

const CollectionEditModal = dynamic(() => import('~/components/Collections/CollectionEditModal'), {
  ssr: false,
});

const collectionEditDialog = routedDialogDictionary.addItem('collectionEdit', {
  component: CollectionEditModal,
  resolve: (query, { collectionId }) => ({
    query: { ...query, collectionId },
  }),
});

export type CollectionEditDialog = typeof collectionEditDialog;
