import { Modal } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

export default function ImageDetailModal({ imageId }: { imageId: number }) {
  const dialog = useDialogContext();

  return (
    <Modal {...dialog}>
      <h1>Hello Worlds</h1>
    </Modal>
  );
}
