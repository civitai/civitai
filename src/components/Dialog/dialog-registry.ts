import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectModal2';

const BrowsingLevelGuide = dynamic(() => import('~/components/BrowsingLevel/BrowsingLevelGuide'));
const SetBrowsingLevelModal = dynamic(
  () => import('~/components/BrowsingLevel/SetBrowsingLevelModal')
);
const HiddenTagsModal = dynamic(() => import('~/components/Tags/HiddenTagsModal'));
const ResourceSelectModal = dynamic(
  () => import('~/components/ImageGeneration/GenerationForm/ResourceSelectModal2')
);

export const openBrowsingLevelGuide = () => dialogStore.trigger({ component: BrowsingLevelGuide });
// TODO.Justin - allow image owners to request image rating change
export const openSetBrowsingLevelModal = (props: { imageId: number; nsfwLevel: number }) =>
  dialogStore.trigger({ component: SetBrowsingLevelModal, props });
export const openHiddenTagsModal = () =>
  dialogStore.trigger({ component: HiddenTagsModal, target: '#browsing-mode' });

export function openResourceSelectModal(props: ResourceSelectModalProps) {
  dialogStore.trigger({ component: ResourceSelectModal, props });
}
