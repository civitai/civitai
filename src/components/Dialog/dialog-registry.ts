import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectModal';
import type { ModelShowcaseCollectionModalProps } from '~/components/ModelShowcaseCollectionModal/ModelShowcaseCollectionModal';

const BrowsingLevelGuide = dynamic(() => import('~/components/BrowsingLevel/BrowsingLevelGuide'));
const SetBrowsingLevelModal = dynamic(
  () => import('~/components/BrowsingLevel/SetBrowsingLevelModal')
);
const HiddenTagsModal = dynamic(() => import('~/components/Tags/HiddenTagsModal'));
const ResourceSelectModal = dynamic(
  () => import('~/components/ImageGeneration/GenerationForm/ResourceSelectModal2')
);
const ModelShowcaseCollectionModal = dynamic(
  () => import('~/components/ModelShowcaseCollectionModal/ModelShowcaseCollectionModal')
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

export function openModelShowcaseCollectionModal(props: ModelShowcaseCollectionModalProps) {
  dialogStore.trigger({ component: ModelShowcaseCollectionModal, props });
}
