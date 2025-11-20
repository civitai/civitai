import dynamic from 'next/dynamic';

// #region [routed dialog components]
// export const ImageDetailModal = dynamic(
//   () => import('~/components/Image/Detail/ImageDetailModal'),
//   {
//     ssr: false,
//   }
// );
// export const CollectionEditModal = dynamic(
//   () => import('~/components/Collections/CollectionEditModal'),
//   {
//     ssr: false,
//   }
// );
// export const HiddenCommentsModal = dynamic(
//   () => import('~/components/CommentsV2/HiddenCommentsModal'),
//   {
//     ssr: false,
//   }
// );
// export const ResourceReviewModal = dynamic(
//   () => import('~/components/ResourceReview/ResourceReviewModal'),
//   { ssr: false }
// );
// export const FilesEditModal = dynamic(() => import('~/components/Resource/FilesEditModal'), {
//   ssr: false,
// });
// export const CommentEditModal = dynamic(
//   () => import('~/components/Model/ModelDiscussion/CommentEditModal'),
//   { ssr: false }
// );
// export const CommentThreadModal = dynamic(
//   () => import('~/components/Model/Discussion/CommentThreadModal'),
//   { ssr: false }
// );
// export const SupportModal = dynamic(() => import('~/components/Support/SupportModal'), {
//   ssr: false,
// });
// #endregion

// #region [dialog components]
export const BrowsingLevelGuide = dynamic(
  () => import('~/components/BrowsingLevel/BrowsingLevelGuide'),
  { ssr: false }
);
export const SetBrowsingLevelModal = dynamic(
  () => import('~/components/BrowsingLevel/SetBrowsingLevelModal'),
  { ssr: false }
);
export const HiddenTagsModal = dynamic(() => import('~/components/Tags/HiddenTagsModal'), {
  ssr: false,
});
export const ResourceSelectModal = dynamic(
  () => import('~/components/ImageGeneration/GenerationForm/ResourceSelectModal2'),
  { ssr: false }
);
export const CollectionSelectModal = dynamic(
  () => import('~/components/CollectionSelectModal/CollectionSelectModal'),
  { ssr: false }
);
export const MigrateModelToCollection = dynamic(
  () => import('~/components/Model/Actions/MigrateModelToCollection'),
  { ssr: false }
);
export const EditResourceReviewModal = dynamic(
  () => import('~/components/ResourceReview/EditResourceReviewModal'),
  { ssr: false }
);
export const ReportModal = dynamic(() => import('~/components/Modals/ReportModal'), {
  ssr: false,
});
export const ImageSelectModal = dynamic(
  () => import('~/components/Training/Form/ImageSelectModal'),
  {
    ssr: false,
  }
);
export const ReadOnlyModal = dynamic(() => import('~/components/Modals/ReadOnlyModal'), {
  ssr: false,
});
export const AddToCollectionModal = dynamic(
  () => import('~/components/Collections/AddToCollectionModal'),
  { ssr: false }
);
export const BlockModelTagsModal = dynamic(
  () => import('~/components/Modals/BlockModelTagsModal'),
  {
    ssr: false,
  }
);
export const UnpublishModal = dynamic(() => import('~/components/Modals/UnpublishModal'), {
  ssr: false,
});
export const ArticleUnpublishModal = dynamic(
  () => import('~/components/Modals/ArticleUnpublishModal'),
  { ssr: false }
);
export const RunStrategyModal = dynamic(() => import('~/components/Modals/RunStrategyModal'), {
  ssr: false,
});
export const CivitaiLinkWizardModal = dynamic(
  () => import('~/components/CivitaiLink/CivitaiLinkWizard'),
  { ssr: false }
);
export const AssociateModelsModal = dynamic(
  () => import('~/components/Modals/AssociateModelsModal'),
  { ssr: false }
);
export const BountyEntryFilesModal = dynamic(
  () => import('~/components/Bounty/BountyEntryFilesModal'),
  { ssr: false }
);
export const ChatShareModal = dynamic(() => import('~/components/Chat/ChatShareModal'), {
  ssr: false,
});
export const UserProfileEditModal = dynamic(
  () => import('~/components/Modals/UserProfileEditModal'),
  { ssr: false }
);
export const CivitaiLinkSuccessModal = dynamic(
  () => import('~/components/CivitaiLink/CivitaiLinkSuccessModal'),
  { ssr: false }
);
export const ManageHomeBlocksModal = dynamic(
  () => import('~/components/HomeBlocks/ManageHomeBlocksModal'),
  { ssr: false }
);
export const CardDecorationModal = dynamic(
  () => import('~/components/Modals/CardDecorationModal'),
  {
    ssr: false,
  }
);
// #endregion
