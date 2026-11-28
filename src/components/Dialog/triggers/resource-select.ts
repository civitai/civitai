import { openDialog } from '~/components/Dialog/openDialog';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';

export function openResourceSelectModal(props: ResourceSelectModalProps) {
  openDialog(
    () => import('~/components/ImageGeneration/GenerationForm/ResourceSelectModal'),
    props
  );
}
