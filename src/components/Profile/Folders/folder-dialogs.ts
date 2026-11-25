import dynamic from 'next/dynamic';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';
import type { FolderEditModalProps } from '~/components/Profile/Folders/FolderEditModal';
import type { ManageFoldersModalProps } from '~/components/Profile/Folders/ManageFoldersModal';

const FolderEditModal = dynamic(() => import('~/components/Profile/Folders/FolderEditModal'), {
  ssr: false,
});
const ManageFoldersModal = dynamic(
  () => import('~/components/Profile/Folders/ManageFoldersModal'),
  { ssr: false }
);

export const openFolderEditModal = createDialogTrigger<FolderEditModalProps>(FolderEditModal);
export const openManageFoldersModal =
  createDialogTrigger<ManageFoldersModalProps>(ManageFoldersModal);
