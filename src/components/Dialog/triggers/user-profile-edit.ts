import dynamic from 'next/dynamic';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const UserProfileEditModal = dynamic(() => import('~/components/Modals/UserProfileEditModal'), {
  ssr: false,
});

export const openUserProfileEditModal = createDialogTrigger(UserProfileEditModal);
