import { useWindowEvent } from '@mantine/hooks';
import { closeAllModals, ContextModalProps, ModalsProvider } from '@mantine/modals';
import dynamic from 'next/dynamic';
import { openCivitaiLinkModal } from '~/components/CivitaiLink/CivitaiLinkWizard';
import { openBlockModelTagsModal } from '~/components/Modals/BlockModelTagsModal';
import { openReportModal } from '~/components/Modals/ReportModal';
import { openRunStrategyModal } from '~/components/Modals/RunStrategyModal';
import { openResourceReviewEditModal } from '~/components/ResourceReview/EditResourceReviewModal';
import { openUnpublishModal } from '~/components/Modals/UnpublishModal';
import { openAssociateModelsModal } from '~/components/Modals/AssociateModelsModal';
import { openAddToCollectionModal } from '~/components/Collections/AddToCollectionModal';
import { openManageHomeBlocksModal } from '~/components/HomeBlocks/ManageHomeBlocksModal';
import { openBuyBuzzModal } from '~/components/Modals/BuyBuzzModal';

const DynamicOnboardingModal = dynamic(
  () => import('~/components/OnboardingModal/OnboardingModal')
);
const QuestionsInfoModal = dynamic(() => import('~/components/Questions/QuestionInfoModal'));
const GeneratedImageLightbox = dynamic(
  () => import('~/components/ImageGeneration/GeneratedImageLightbox')
);
const BlockModelTagsModal = dynamic(() => import('~/components/Modals/BlockModelTagsModal'));
const ReportModal = dynamic(() => import('~/components/Modals/ReportModal'));
const RunStrategyModal = dynamic(() => import('~/components/Modals/RunStrategyModal'));
const AssociateModelsModal = dynamic(() => import('~/components/Modals/AssociateModelsModal'));
const CivitaiLinkWizard = dynamic(() => import('~/components/CivitaiLink/CivitaiLinkWizard'));
const ResourceReviewEdit = dynamic(
  () => import('~/components/ResourceReview/EditResourceReviewModal')
);
const CivitaiLinkSuccessModal = dynamic(
  () => import('~/components/CivitaiLink/CivitaiLinkSuccessModal')
);
const UnpublishModal = dynamic(() => import('~/components/Modals/UnpublishModal'));
const GenerationResourceModal = dynamic(
  () => import('~/components/ImageGeneration/GenerationResources/GenerationResourceModal')
);
const ResourceSelectModal = dynamic(
  () => import('~/components/ImageGeneration/GenerationForm/ResourceSelectModal')
);
const BoostModal = dynamic(() => import('~/components/ImageGeneration/BoostModal'));
const AddToCollectionModal = dynamic(() => import('~/components/Collections/AddToCollectionModal'));
const ManageHomeBlocksModal = dynamic(
  () => import('~/components/HomeBlocks/ManageHomeBlocksModal')
);
const BuyBuzzModal = dynamic(() => import('~/components/Modals/BuyBuzzModal'));

const registry = {
  blockModelTags: {
    Component: BlockModelTagsModal,
    fn: openBlockModelTagsModal,
  },
  report: {
    Component: ReportModal,
    fn: openReportModal,
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
  resourceReviewEdit: {
    Component: ResourceReviewEdit,
    fn: openResourceReviewEditModal,
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
  buyBuzz: {
    Component: BuyBuzzModal,
    fn: openBuyBuzzModal,
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
          onboarding: DynamicOnboardingModal,
          questionsInfo: QuestionsInfoModal,
          generatedImageLightbox: GeneratedImageLightbox,
          generationResourceModal: GenerationResourceModal,
          resourceSelectModal: ResourceSelectModal,
          boostModal: BoostModal,
          'civitai-link-success': CivitaiLinkSuccessModal,
          ...(Object.keys(registry) as Array<keyof typeof registry>).reduce<any>((acc, key) => {
            acc[key] = registry[key].Component;
            return acc;
          }, {}),
        } as Record<string, React.FC<ContextModalProps<any>>> //eslint-disable-line
      }
      // Setting zIndex so confirm modals popup above everything else
      modalProps={{
        zIndex: 300,
      }}
    >
      {children}
    </ModalsProvider>
  );
};

export function openContext<TName extends keyof typeof registry>(
  modal: TName,
  props: Parameters<(typeof registry)[TName]['fn']>[0]
) {
  registry[modal].fn(props as any);
}
