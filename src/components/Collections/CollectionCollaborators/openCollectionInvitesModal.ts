import { openDialog } from '~/components/Dialog/openDialog';

export function openCollectionInvitesModal() {
  openDialog(
    () => import('~/components/Collections/CollectionCollaborators/CollectionInvitesModal')
  );
}
