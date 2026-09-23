import { Modal } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import type { ResourceSelectModalProps } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { ResourceSelectProvider } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { ResourceSelectModalContent } from './ResourceSelectModalContent';

/** Sized so the grid clears four columns — see MIN_COLUMN_WIDTH in ResourceHitList. */
const CATALOG_WIDTH = 1276;

export default function ResourceSelectModal(props: ResourceSelectModalProps) {
  const dialog = useDialogContext();
  // Viewport, not container: the modal sets no containerType, so a container
  // query never resolves inside it. Matches ReviewListingModal's choice.
  const isMobile = useIsMobile({ type: 'media' });

  function handleClose() {
    dialog.onClose();
    props.onClose?.();
  }

  return (
    <Modal
      {...dialog}
      onClose={handleClose}
      size={CATALOG_WIDTH}
      fullScreen={isMobile}
      withCloseButton={false}
      padding={0}
      styles={{
        content: { overflow: 'hidden', display: 'flex', flexDirection: 'column' },
        body: { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
      }}
    >
      <ResourceSelectProvider {...props}>
        <ResourceSelectModalContent />
      </ResourceSelectProvider>
    </Modal>
  );
}
