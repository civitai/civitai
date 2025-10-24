import dynamic from 'next/dynamic';
import type { SetBrowsingLevelModalProps } from '~/components/BrowsingLevel/SetBrowsingLevelModal';
import type { CollectionSelectModalProps } from '~/components/CollectionSelectModal/CollectionSelectModal';
import { dialogStore, createDialogTrigger } from '~/components/Dialog/dialogStore';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import type { ReportModalProps } from '~/components/Modals/ReportModal';
import type { EditResourceReviewModalProps } from '~/components/ResourceReview/EditResourceReviewModal';
import type { ImageSelectModalProps } from '~/components/Training/Form/ImageSelectModal';

const BrowsingLevelGuide = dynamic(() => import('~/components/BrowsingLevel/BrowsingLevelGuide'), {
  ssr: false,
});
const SetBrowsingLevelModal = dynamic(
  () => import('~/components/BrowsingLevel/SetBrowsingLevelModal'),
  { ssr: false }
);
const HiddenTagsModal = dynamic(() => import('~/components/Tags/HiddenTagsModal'), { ssr: false });
const ResourceSelectModal = dynamic(
  () => import('~/components/ImageGeneration/GenerationForm/ResourceSelectModal2'),
  { ssr: false }
);
const CollectionSelectModal = dynamic(
  () => import('~/components/CollectionSelectModal/CollectionSelectModal'),
  { ssr: false }
);
const MigrateModelToCollection = dynamic(
  () => import('~/components/Model/Actions/MigrateModelToCollection'),
  { ssr: false }
);
const EditResourceReviewModal = dynamic(
  () => import('~/components/ResourceReview/EditResourceReviewModal'),
  { ssr: false }
);
const ReportModal = dynamic(() => import('~/components/Modals/ReportModal'), { ssr: false });
const ImageSelectModal = dynamic(() => import('~/components/Training/Form/ImageSelectModal'), {
  ssr: false,
});
const ReadOnlyModal = dynamic(() => import('~/components/Modals/ReadOnlyModal'), { ssr: false });
const AddToCollectionModal = dynamic(
  () => import('~/components/Collections/AddToCollectionModal'),
  { ssr: false }
);

const BlockModelTagsModal = dynamic(() => import('~/components/Modals/BlockModelTagsModal'), {
  ssr: false,
});
export const openBlockModelTagsModal = createDialogTrigger(BlockModelTagsModal);

const UnpublishModal = dynamic(() => import('~/components/Modals/UnpublishModal'), { ssr: false });
export const openUnpublishModal = createDialogTrigger(UnpublishModal);

const ArticleUnpublishModal = dynamic(
  () => import('~/components/Modals/ArticleUnpublishModal'),
  { ssr: false }
);
export const openArticleUnpublishModal = createDialogTrigger(ArticleUnpublishModal);

const RunStrategyModal = dynamic(() => import('~/components/Modals/RunStrategyModal'), {
  ssr: false,
});
export const openRunStrategyModal = createDialogTrigger(RunStrategyModal);

const CivitaiLinkWizardModal = dynamic(() => import('~/components/CivitaiLink/CivitaiLinkWizard'), {
  ssr: false,
});
export const openCivitaiLinkWizardModal = createDialogTrigger(CivitaiLinkWizardModal);

const AssociateModelsModal = dynamic(() => import('~/components/Modals/AssociateModelsModal'), {
  ssr: false,
});
export const openAssociateModelsModal = createDialogTrigger(AssociateModelsModal);

const BountyEntryFilesModal = dynamic(() => import('~/components/Bounty/BountyEntryFilesModal'), {
  ssr: false,
});
export const openBountyEntryFilesModal = createDialogTrigger(BountyEntryFilesModal);

const ChatShareModal = dynamic(() => import('~/components/Chat/ChatShareModal'), { ssr: false });
export const openChatShareModal = createDialogTrigger(ChatShareModal);

const UserProfileEditModal = dynamic(() => import('~/components/Modals/UserProfileEditModal'), {
  ssr: false,
});
export const openUserProfileEditModal = createDialogTrigger(UserProfileEditModal);

const CivitaiLinkSuccessModal = dynamic(
  () => import('~/components/CivitaiLink/CivitaiLinkSuccessModal'),
  { ssr: false }
);
export const openCivitaiLinkSuccessModal = createDialogTrigger(CivitaiLinkSuccessModal);

const ManageHomeBlocksModal = dynamic(
  () => import('~/components/HomeBlocks/ManageHomeBlocksModal'),
  { ssr: false }
);
export const openManageHomeBlocksModal = createDialogTrigger(ManageHomeBlocksModal);

const CardDecorationModal = dynamic(() => import('~/components/Modals/CardDecorationModal'), {
  ssr: false,
});
export const openCardDecorationModal = createDialogTrigger(CardDecorationModal);

const LoginModal = dynamic(() => import('~/components/Login/LoginModal'), { ssr: false });
export const openLoginModal = createDialogTrigger(LoginModal);

export const openBrowsingLevelGuide = () => dialogStore.trigger({ component: BrowsingLevelGuide });
// TODO.Justin - allow image owners to request image rating change
export const openSetBrowsingLevelModal = (props: SetBrowsingLevelModalProps) =>
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
