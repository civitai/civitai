import { openDialog } from '~/components/Dialog/openDialog';
import type { FolderEditModalProps } from '~/components/Profile/Folders/FolderEditModal';
import type { ManageFoldersModalProps } from '~/components/Profile/Folders/ManageFoldersModal';

export const openFolderEditModal = (props: FolderEditModalProps) =>
  openDialog(() => import('~/components/Profile/Folders/FolderEditModal'), props);

export const openManageFoldersModal = (props: ManageFoldersModalProps) =>
  openDialog(() => import('~/components/Profile/Folders/ManageFoldersModal'), props);
