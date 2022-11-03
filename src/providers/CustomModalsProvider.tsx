import { ContextModalProps, ModalsProvider } from '@mantine/modals';
import dynamic from 'next/dynamic';
const DynamicReviewEditModal = dynamic(() => import('~/components/Review/ReviewEditModal'));
const DynamicLightboxImageCarousel = dynamic(
  () => import('~/components/LightboxImageCarousel/LightboxImageCarousel')
);

type CustomModalsProviderProps = {
  children: React.ReactNode;
};

export function CustomModalsProvider({ children }: CustomModalsProviderProps) {
  return (
    <ModalsProvider
      modals={{
        reviewEdit: DynamicReviewEditModal as React.FC<ContextModalProps<any>>,
        imageLightbox: DynamicLightboxImageCarousel as React.FC<ContextModalProps<any>>,
      }}
    >
      {children}
    </ModalsProvider>
  );
}
