import { ContextModalProps, ModalsProvider } from '@mantine/modals';
import dynamic from 'next/dynamic';
const DynamicReviewEditModal = dynamic(() => import('~/components/Review/ReviewEditModal'));
const DynamicOnboardingModal = dynamic(
  () => import('~/components/OnboardingModal/OnboardingModal')
);
const DynamicLightboxImageCarousel = dynamic(
  () => import('~/components/LightboxImageCarousel/LightboxImageCarousel')
);

type CustomModalsProviderProps = {
  children: React.ReactNode;
};

export function CustomModalsProvider({ children }: CustomModalsProviderProps) {
  return (
    <ModalsProvider
      labels={{
        confirm: 'Confirm',
        cancel: 'Cancel',
      }}
      modals={
        {
          reviewEdit: DynamicReviewEditModal,
          imageLightbox: DynamicLightboxImageCarousel,
          onboarding: DynamicOnboardingModal,
        } as Record<string, React.FC<ContextModalProps<any>>>
      }
    >
      {children}
    </ModalsProvider>
  );
}
