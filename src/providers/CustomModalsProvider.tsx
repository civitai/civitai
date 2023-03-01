import { useWindowEvent } from '@mantine/hooks';
import { closeAllModals, ContextModalProps, ModalsProvider } from '@mantine/modals';
import dynamic from 'next/dynamic';
import { openCivitaiLinkModal } from '~/components/CivitaiLink/CivitaiLinkWizard';
import { openBlockModelTagsModal } from '~/components/Modals/BlockModelTagsModal';
import { openReportModal } from '~/components/Modals/ReportModal';
import { openRunStrategyModal } from '~/components/Modals/RunStrategyModal';

const DynamicOnboardingModal = dynamic(
  () => import('~/components/OnboardingModal/OnboardingModal')
);
const QuestionsInfoModal = dynamic(() => import('~/components/Questions/QuestionInfoModal'));
const BlockModelTagsModal = dynamic(() => import('~/components/Modals/BlockModelTagsModal'));
const ReportModal = dynamic(() => import('~/components/Modals/ReportModal'));
const RunStrategyModal = dynamic(() => import('~/components/Modals/RunStrategyModal'));
const CivitaiLinkWizard = dynamic(() => import('~/components/CivitaiLink/CivitaiLinkWizard'));
const CivitaiLinkSuccessModal = dynamic(
  () => import('~/components/CivitaiLink/CivitaiLinkSuccessModal')
);

const registry = {
  blockModelTags: {
    Component: BlockModelTagsModal,
    fn: openBlockModelTagsModal,
  },
  report: {
    Component: ReportModal,
    fn: openReportModal,
  },
  runStrategy: {
    Component: RunStrategyModal,
    fn: openRunStrategyModal,
  },
  'civitai-link-wizard': {
    Component: CivitaiLinkWizard,
    fn: openCivitaiLinkModal,
  },
};

export const CustomModalsProvider = ({ children }: { children: React.ReactNode }) => {
  const handlePopState = () => {
    if (!location.href.includes('#')) {
      closeAllModals();
    }
  };
  useWindowEvent('popstate', handlePopState);

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
  props: Parameters<typeof registry[TName]['fn']>[0]
) {
  registry[modal].fn(props as any);
}
