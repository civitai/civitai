import dynamic from 'next/dynamic';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const HiddenImagesFromUserModal = dynamic(
  () => import('~/components/HiddenPreferences/HiddenImagesFromUserModal'),
  { ssr: false }
);

export const openHiddenImagesFromUserModal = createDialogTrigger(HiddenImagesFromUserModal);
