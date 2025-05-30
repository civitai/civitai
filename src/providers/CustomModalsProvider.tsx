import { ModalsProvider } from '@mantine/modals';

export const CustomModalsProvider = ({ children }: { children: React.ReactNode }) => {
  return (
    <ModalsProvider
      labels={{
        confirm: 'Confirm',
        cancel: 'Cancel',
      }}
      modalProps={{
        zIndex: 400,
      }}
    >
      {children}
    </ModalsProvider>
  );
};
