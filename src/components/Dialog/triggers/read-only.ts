import { openDialog } from '~/components/Dialog/openDialog';

export function openReadOnlyModal() {
  openDialog(() => import('~/components/Modals/ReadOnlyModal'));
}
