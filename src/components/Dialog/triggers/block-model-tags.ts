import dynamic from 'next/dynamic';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const BlockModelTagsModal = dynamic(() => import('~/components/Modals/BlockModelTagsModal'), {
  ssr: false,
});

export const openBlockModelTagsModal = createDialogTrigger(BlockModelTagsModal);
