import { ContextModalProps, ModalsProvider } from '@mantine/modals';
import dynamic from 'next/dynamic';

const DynamicOnboardingModal = dynamic(
  () => import('~/components/OnboardingModal/OnboardingModal')
);

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
        } as Record<string, React.FC<ContextModalProps<any>>>
      }
    >
      {children}
    </ModalsProvider>
  );
};
