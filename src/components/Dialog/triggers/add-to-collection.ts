import type { ComponentProps } from 'react';
import type AddToCollectionModal from '~/components/Collections/AddToCollectionModal';
import { openDialog } from '~/components/Dialog/openDialog';

export function openAddToCollectionModal({
  props,
}: {
  props: ComponentProps<typeof AddToCollectionModal>;
}) {
  openDialog(() => import('~/components/Collections/AddToCollectionModal'), props);
}
