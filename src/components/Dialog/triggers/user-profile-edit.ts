import { openDialog } from '~/components/Dialog/openDialog';

export function openUserProfileEditModal() {
  openDialog(() => import('~/components/Modals/UserProfileEditModal'));
}
