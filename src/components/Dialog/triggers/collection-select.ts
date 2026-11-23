import type { CollectionSelectModalProps } from '~/components/CollectionSelectModal/CollectionSelectModal';
import { openDialog } from '~/components/Dialog/openDialog';

export function openCollectionSelectModal(props: CollectionSelectModalProps) {
  openDialog(() => import('~/components/CollectionSelectModal/CollectionSelectModal'), props);
}
