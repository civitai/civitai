import dynamic from 'next/dynamic';
import { routedDialogDictionary } from '~/components/Dialog/routed-dialog/utils';

const FilesEditModal = dynamic(() => import('~/components/Resource/FilesEditModal'), {
  ssr: false,
});

const filesEditDialog = routedDialogDictionary.addItem('filesEdit', {
  component: FilesEditModal,
  resolve: (query, { modelVersionId }) => ({
    query: { ...query, modelVersionId },
  }),
});

export type FilesEditDialog = typeof filesEditDialog;
