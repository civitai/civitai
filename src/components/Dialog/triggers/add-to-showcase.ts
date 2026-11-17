import dynamic from 'next/dynamic';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const AddToShowcaseModal = dynamic(() => import('~/components/Profile/AddToShowcaseModal'), {
  ssr: false,
});

export const openAddToShowcaseModal = createDialogTrigger(AddToShowcaseModal);
