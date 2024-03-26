import { Modal } from '@mantine/core';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

export default function HiddenTagsModal() {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} title="Hidden Tags">
      <HiddenTagsSection />
    </Modal>
  );
}
