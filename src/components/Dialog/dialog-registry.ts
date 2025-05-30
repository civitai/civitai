import dynamic from 'next/dynamic';
import type { CollectionSelectModalProps } from '~/components/CollectionSelectModal/CollectionSelectModal';
import { dialogStore, createDialogTrigger } from '~/components/Dialog/dialogStore';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectModal2';
import type { ReportModalProps } from '~/components/Modals/ReportModal';
import type { EditResourceReviewModalProps } from '~/components/ResourceReview/EditResourceReviewModal';
import type { ImageSelectModalProps } from '~/components/Training/Form/ImageSelectModal';

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
const ReadOnlyModal = dynamic(() => import('~/components/Modals/ReadOnlyModal'));
const AddToCollectionModal = dynamic(() => import('~/components/Collections/AddToCollectionModal'));

const BlockModelTagsModal = dynamic(() => import('~/components/Modals/BlockModelTagsModal'));
export const openBlockModelTagsModal = createDialogTrigger(BlockModelTagsModal);

const UnpublishModal = dynamic(() => import('~/components/Modals/UnpublishModal'));
export const openUnpublishModal = createDialogTrigger(UnpublishModal);

export const openBrowsingLevelGuide = () => dialogStore.trigger({ component: BrowsingLevelGuide });
// TODO.Justin - allow image owners to request image rating change
export const openSetBrowsingLevelModal = (props: { imageId: number; nsfwLevel: number }) =>
  dialogStore.trigger({ component: SetBrowsingLevelModal, props });
// export const openHiddenTagsModal = () =>
//   dialogStore.trigger({ component: HiddenTagsModal, target: '#browsing-mode' });

export function openResourceSelectModal(props: ResourceSelectModalProps) {
  dialogStore.trigger({
    component: ResourceSelectModal,
    props,
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

export function openReadOnlyModal() {
  dialogStore.trigger({ component: ReadOnlyModal });
}

export const openAddToCollectionModal = createDialogTrigger(AddToCollectionModal);
export const openHiddenTagsModal = createDialogTrigger(HiddenTagsModal, {
  target: '#browsing-mode',
});
