import dynamic from 'next/dynamic';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const UnpublishModal = dynamic(() => import('~/components/Modals/UnpublishModal'), {
  ssr: false,
});

export const openUnpublishModal = createDialogTrigger(UnpublishModal);
