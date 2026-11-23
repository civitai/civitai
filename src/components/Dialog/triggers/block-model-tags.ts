import type { ComponentProps } from 'react';
import { openDialog } from '~/components/Dialog/openDialog';
import type BlockModelTagsModal from '~/components/Modals/BlockModelTagsModal';

export function openBlockModelTagsModal({
  props,
}: {
  props: ComponentProps<typeof BlockModelTagsModal>;
}) {
  openDialog(() => import('~/components/Modals/BlockModelTagsModal'), props);
}
