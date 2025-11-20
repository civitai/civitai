import dynamic from 'next/dynamic';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const AddToCollectionModal = dynamic(
  () => import('~/components/Collections/AddToCollectionModal'),
  { ssr: false }
);

export const openAddToCollectionModal = createDialogTrigger(AddToCollectionModal);
