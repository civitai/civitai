import { Modal } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { ResourceSelectProvider } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { ResourceSelectModalContent } from './ResourceSelectModalContent';

export default function ResourceSelectModal(props: ResourceSelectModalProps) {
  const dialog = useDialogContext();

  function handleClose() {
    dialog.onClose();
    props.onClose?.();
  }

  return (
    <Modal
      {...dialog}
      onClose={handleClose}
      size={1200}
      withCloseButton={false}
      padding={0}
      styles={{
        content: { overflow: 'hidden', display: 'flex', flexDirection: 'column' },
        body: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
      }}
    >
      {/* Unique key + disabled: without an explicit key this falls back to the
          page-path key and restore() would apply the underlying page's scroll
          offset to the modal on open. A private key has no recorded position. */}
      <ScrollArea
        id="resource-select-modal"
        scrollRestore={{ key: 'resource-select-modal', enabled: false }}
      >
        <ResourceSelectProvider {...props}>
          <ResourceSelectModalContent />
        </ResourceSelectProvider>
      </ScrollArea>
    </Modal>
  );
}
