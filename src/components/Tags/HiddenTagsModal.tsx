import { Modal, Stack } from '@mantine/core';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { BrowsingCategories } from '~/components/BrowsingMode/BrowsingCategories';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

export default function HiddenTagsModal() {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} title="Hidden Tags">
      <Stack spacing={8}>
        <BrowsingCategories />
        <HiddenTagsSection withTitle={false} />
      </Stack>
    </Modal>
  );
}
