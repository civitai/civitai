import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';

const ResourceSelectModal = dynamic(
  () => import('~/components/ImageGeneration/GenerationForm/ResourceSelectModal2'),
  { ssr: false }
);

export function openResourceSelectModal(props: ResourceSelectModalProps) {
  dialogStore.trigger({
    component: ResourceSelectModal,
    props,
  });
}
