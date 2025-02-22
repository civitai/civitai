import dynamic from 'next/dynamic';
import type { CollectionSelectModalProps } from '~/components/CollectionSelectModal/CollectionSelectModal';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectModal2';
import type { ReportModalProps } from '~/components/Modals/ReportModal';
import type { EditResourceReviewModalProps } from '~/components/ResourceReview/EditResourceReviewModal';
import { ImageSelectModalProps } from '~/components/Training/Form/ImageSelectModal';

const BrowsingLevelGuide = dynamic(() => import('~/components/BrowsingLevel/BrowsingLevelGuide'));
const SetBrowsingLevelModal = dynamic(
  () => import('~/components/BrowsingLevel/SetBrowsingLevelModal')
);
const HiddenTagsModal = dynamic(() => import('~/components/Tags/HiddenTagsModal'));
const ResourceSelectModal = dynamic(
  () => import('~/components/ImageGeneration/GenerationForm/ResourceSelectModal2')
);
const CollectionSelectModal = dynamic(
  () => import('~/components/CollectionSelectModal/CollectionSelectModal')
);
const MigrateModelToCollection = dynamic(
  () => import('~/components/Model/Actions/MigrateModelToCollection')
);
const EditResourceReviewModal = dynamic(
  () => import('~/components/ResourceReview/EditResourceReviewModal')
);
const ReportModal = dynamic(() => import('~/components/Modals/ReportModal'));
const ImageSelectModal = dynamic(() => import('~/components/Training/Form/ImageSelectModal'));

export const openBrowsingLevelGuide = () => dialogStore.trigger({ component: BrowsingLevelGuide });
// TODO.Justin - allow image owners to request image rating change
export const openSetBrowsingLevelModal = (props: { imageId: number; nsfwLevel: number }) =>
  dialogStore.trigger({ component: SetBrowsingLevelModal, props });
export const openHiddenTagsModal = () =>
  dialogStore.trigger({ component: HiddenTagsModal, target: '#browsing-mode' });

export function openResourceSelectModal(props: ResourceSelectModalProps) {
  const resources = props.options?.resources?.map(
    ({ type, baseModels = [], partialSupport = [] }) => ({
      type,
      baseModels,
      partialSupport,
      allSupportedBaseModels: [...baseModels, ...partialSupport],
    })
  );
  dialogStore.trigger({
    component: ResourceSelectModal,
    props: { ...props, options: { ...props.options, resources } },
  });
}

export function openCollectionSelectModal(props: CollectionSelectModalProps) {
  dialogStore.trigger({ component: CollectionSelectModal, props });
}

export function openMigrateModelToCollectionModal(props: { modelId: number }) {
  dialogStore.trigger({ component: MigrateModelToCollection, props });
}

export function openResourceReviewEditModal(props: EditResourceReviewModalProps) {
  dialogStore.trigger({ component: EditResourceReviewModal, props });
}

export function openReportModal(props: ReportModalProps) {
  dialogStore.trigger({ component: ReportModal, props });
}

export function openImageSelectModal(props: ImageSelectModalProps) {
  dialogStore.trigger({ component: ImageSelectModal, props });
}
