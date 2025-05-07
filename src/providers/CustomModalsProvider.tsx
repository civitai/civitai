import { ModalProps } from '@mantine/core';
import { ContextModalProps, ModalsProvider } from '@mantine/modals';
import dynamic from 'next/dynamic';
import { openBountyEntryFilesModal } from '~/components/Bounty/BountyEntryFilesModal';
import { openChatShareModal } from '~/components/Chat/ChatShareModal';
import { openCivitaiLinkModal } from '~/components/CivitaiLink/CivitaiLinkWizard';
import { openAddToCollectionModal } from '~/components/Collections/AddToCollectionModal';
import { openManageHomeBlocksModal } from '~/components/HomeBlocks/ManageHomeBlocksModal';
import { openAssociateModelsModal } from '~/components/Modals/AssociateModelsModal';
import { openBlockModelTagsModal } from '~/components/Modals/BlockModelTagsModal';
import { openManageClubPostModal } from '~/components/Modals/ManageClubPostModal';
import { openRunStrategyModal } from '~/components/Modals/RunStrategyModal';
// import { openSendTipModal } from '~/components/Modals/SendTipModal';
import { openStripeTransactionModal } from '~/components/Modals/StripeTransactionModal';
import { openUnpublishModal } from '~/components/Modals/UnpublishModal';
import { openUserProfileEditModal } from '~/components/Modals/UserProfileEditModal';

const QuestionsInfoModal = dynamic(() => import('~/components/Questions/QuestionInfoModal'));
const BlockModelTagsModal = dynamic(() => import('~/components/Modals/BlockModelTagsModal'));
const RunStrategyModal = dynamic(() => import('~/components/Modals/RunStrategyModal'));
const AssociateModelsModal = dynamic(() => import('~/components/Modals/AssociateModelsModal'));
const CivitaiLinkWizard = dynamic(() => import('~/components/CivitaiLink/CivitaiLinkWizard'));
const CivitaiLinkSuccessModal = dynamic(
  () => import('~/components/CivitaiLink/CivitaiLinkSuccessModal')
);
const UnpublishModal = dynamic(() => import('~/components/Modals/UnpublishModal'));
const AddToCollectionModal = dynamic(() => import('~/components/Collections/AddToCollectionModal'));
const ManageHomeBlocksModal = dynamic(
  () => import('~/components/HomeBlocks/ManageHomeBlocksModal')
);
// const SendTipModal = dynamic(() => import('~/components/Modals/SendTipModal'));
const BountyEntryFilesModal = dynamic(() => import('~/components/Bounty/BountyEntryFilesModal'));
const StripeTransactionModal = dynamic(() => import('~/components/Modals/StripeTransactionModal'));
const UserProfileEditModal = dynamic(() => import('~/components/Modals/UserProfileEditModal'));
const ManageClubPostModal = dynamic(() => import('~/components/Modals/ManageClubPostModal'));
const ChatShareModal = dynamic(() => import('~/components/Chat/ChatShareModal'));

const registry = {
  blockModelTags: {
    Component: BlockModelTagsModal,
    fn: openBlockModelTagsModal,
  },
  unpublishModel: {
    Component: UnpublishModal,
    fn: openUnpublishModal,
  },
  runStrategy: {
    Component: RunStrategyModal,
    fn: openRunStrategyModal,
  },
  'civitai-link-wizard': {
    Component: CivitaiLinkWizard,
    fn: openCivitaiLinkModal,
  },
  associateModels: {
    Component: AssociateModelsModal,
    fn: openAssociateModelsModal,
  },
  addToCollection: {
    Component: AddToCollectionModal,
    fn: openAddToCollectionModal,
  },
  manageHomeBlocks: {
    Component: ManageHomeBlocksModal,
    fn: openManageHomeBlocksModal,
  },
  // sendTip: {
  //   Component: SendTipModal,
  //   fn: openSendTipModal,
  // },
  bountyEntryFiles: {
    Component: BountyEntryFilesModal,
    fn: openBountyEntryFilesModal,
  },
  stripeTransaction: {
    Component: StripeTransactionModal,
    fn: openStripeTransactionModal,
  },
  userProfileEditModal: {
    Component: UserProfileEditModal,
    fn: openUserProfileEditModal,
  },
  manageClubPostModal: {
    Component: ManageClubPostModal,
    fn: openManageClubPostModal,
  },
  // imageGenQualityFeedbackModal: {
  //   Component: GenQualityFeedbackModal,
  //   fn: openGenQualityFeedbackModal,
  // },
  chatShareModal: {
    Component: ChatShareModal,
    fn: openChatShareModal,
  },
};

export const CustomModalsProvider = ({ children }: { children: React.ReactNode }) => {
  // TODO.briant - fix the scrolling this was causing...
  // const handlePopState = () => {
  //   if (!location.href.includes('#')) {
  //     closeAllModals();
  //   }
  // };
  // useWindowEvent('popstate', handlePopState);

  return (
    <ModalsProvider
      labels={{
        confirm: 'Confirm',
        cancel: 'Cancel',
      }}
      modals={
        {
          questionsInfo: QuestionsInfoModal,
          'civitai-link-success': CivitaiLinkSuccessModal,
          ...(Object.keys(registry) as Array<keyof typeof registry>).reduce<any>((acc, key) => {
            acc[key] = registry[key].Component;
            return acc;
          }, {}),
        } as Record<string, React.FC<ContextModalProps<any>>> //eslint-disable-line
      }
      // Setting zIndex so confirm modals popup above everything else
      modalProps={{
        zIndex: 400,
      }}
    >
      {children}
    </ModalsProvider>
  );
};

export function openContext<TName extends keyof typeof registry>(
  modal: TName,
  props: Parameters<(typeof registry)[TName]['fn']>[0],
  modalProps?: Omit<ModalProps, 'opened' | 'onClose'>
) {
  registry[modal].fn(props as any, modalProps);
}
