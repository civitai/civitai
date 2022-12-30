import { ContextModalProps, ModalsProvider } from '@mantine/modals';
import dynamic from 'next/dynamic';

const DynamicOnboardingModal = dynamic(
  () => import('~/components/OnboardingModal/OnboardingModal')
);
const QuestionsInfoModal = dynamic(() => import('~/components/Questions/QuestionInfoModal'));

export const CustomModalsProvider = ({ children }: { children: React.ReactNode }) => {
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
        } as Record<string, React.FC<ContextModalProps<any>>> //eslint-disable-line
      }
      // Setting zIndex so confirm modals popup above everything else
      modalProps={{ zIndex: 300 }}
    >
      {children}
    </ModalsProvider>
  );
};
