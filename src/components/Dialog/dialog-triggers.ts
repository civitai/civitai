import type { SetBrowsingLevelModalProps } from '~/components/BrowsingLevel/SetBrowsingLevelModal';
import type { CollectionSelectModalProps } from '~/components/CollectionSelectModal/CollectionSelectModal';
import { dialogStore, createDialogTrigger } from '~/components/Dialog/dialogStore';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import type { ReportModalProps } from '~/components/Modals/ReportModal';
import type { EditResourceReviewModalProps } from '~/components/ResourceReview/EditResourceReviewModal';
import type { ImageSelectModalProps } from '~/components/Training/Form/ImageSelectModal';
import {
  BrowsingLevelGuide,
  SetBrowsingLevelModal,
  HiddenTagsModal,
  ResourceSelectModal,
  CollectionSelectModal,
  MigrateModelToCollection,
  EditResourceReviewModal,
  ReportModal,
  ImageSelectModal,
  ReadOnlyModal,
  AddToCollectionModal,
  BlockModelTagsModal,
  UnpublishModal,
  ArticleUnpublishModal,
  RunStrategyModal,
  CivitaiLinkWizardModal,
  AssociateModelsModal,
  BountyEntryFilesModal,
  ChatShareModal,
  UserProfileEditModal,
  CivitaiLinkSuccessModal,
  ManageHomeBlocksModal,
  CardDecorationModal,
} from './dialog-registry';

export const openBlockModelTagsModal = createDialogTrigger(BlockModelTagsModal);
export const openUnpublishModal = createDialogTrigger(UnpublishModal);
export const openArticleUnpublishModal = createDialogTrigger(ArticleUnpublishModal);
export const openRunStrategyModal = createDialogTrigger(RunStrategyModal);
export const openCivitaiLinkWizardModal = createDialogTrigger(CivitaiLinkWizardModal);
export const openAssociateModelsModal = createDialogTrigger(AssociateModelsModal);
export const openBountyEntryFilesModal = createDialogTrigger(BountyEntryFilesModal);
export const openChatShareModal = createDialogTrigger(ChatShareModal);
export const openUserProfileEditModal = createDialogTrigger(UserProfileEditModal);
export const openCivitaiLinkSuccessModal = createDialogTrigger(CivitaiLinkSuccessModal);
export const openManageHomeBlocksModal = createDialogTrigger(ManageHomeBlocksModal);
export const openCardDecorationModal = createDialogTrigger(CardDecorationModal);
export const openAddToCollectionModal = createDialogTrigger(AddToCollectionModal);
export const openHiddenTagsModal = createDialogTrigger(HiddenTagsModal, {
  target: '#browsing-mode',
});

export const openBrowsingLevelGuide = () => dialogStore.trigger({ component: BrowsingLevelGuide });

// TODO.Justin - allow image owners to request image rating change
export const openSetBrowsingLevelModal = (props: SetBrowsingLevelModalProps) =>
  dialogStore.trigger({ component: SetBrowsingLevelModal, props });

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
