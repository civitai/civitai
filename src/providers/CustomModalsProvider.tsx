import { ContextModalProps, ModalsProvider } from '@mantine/modals';
import dynamic from 'next/dynamic';
const DynamicReviewEditModal = dynamic(() => import('~/components/Review/ReviewEditModal'));

type CustomModalsProviderProps = {
  children: React.ReactNode;
};

export function CustomModalsProvider({ children }: CustomModalsProviderProps) {
  return (
    <ModalsProvider
      modals={{ reviewEdit: DynamicReviewEditModal as React.FC<ContextModalProps<any>> }}
    >
      {children}
    </ModalsProvider>
  );
}
