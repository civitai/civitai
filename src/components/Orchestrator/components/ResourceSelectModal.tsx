import { Modal } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

export function ResourceSelectModal({ title }: { title: React.ReactNode }) {
  const dialog = useDialogContext();

  return <Modal {...dialog} title={title} size={1200}></Modal>;
}
