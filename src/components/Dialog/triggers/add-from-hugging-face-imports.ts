import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { AddFromImportsModalProps } from '~/components/Moderation/HuggingFaceImport/AddFromImportsModal';

const AddFromImportsModal = dynamic(
  () => import('~/components/Moderation/HuggingFaceImport/AddFromImportsModal'),
  { ssr: false }
);

export function openAddFromImportsModal(props: AddFromImportsModalProps) {
  dialogStore.trigger({ component: AddFromImportsModal, props });
}
